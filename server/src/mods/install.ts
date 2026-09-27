import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DockerClient } from '../docker/client.js';
import { createHelperRunner } from '../docker/helper.js';
import type { ServerConfig } from '../config.js';
import { buildTarEntries, type TarEntry } from '../tar.js';
import { satisfies } from './semver.js';
import { runScanners, worstState, type ScannerConfig, type ScanVerdict } from './scan.js';
import {
  ArchiveError,
  analyse,
  extractEntry,
  readCentralDirectory,
  type ArchiveReport,
  type ZipEntry,
} from './zip.js';
import { ModSourceError, type ModSource, type ModVersion } from './sources.js';

/**
 * Turning a repository listing into files inside a game server.
 *
 * The order is the design: everything that can refuse does so before a single
 * byte is written, and the write itself is one atomic-ish archive push rather
 * than a file-by-file dribble that could leave a half-installed mod behind.
 * Every path written is recorded, because an uninstall that guesses at what to
 * delete is worse than none.
 */

/** No mod legitimately needs more than this, and a cap bounds the damage. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type FindingState = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Finding {
  id: string;
  label: string;
  state: FindingState;
  summary: string;
  detail?: string;
}

export interface InstallPlan {
  source: string;
  modId: string;
  modName: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  /** Where each archive entry will land, relative to the server's data root. */
  targetDirectory: string;
  fileCount: number;
  archive: ArchiveReport;
  scans: ScanVerdict[];
  findings: Finding[];
  /** False when something refused outright; such a plan cannot be installed. */
  installable: boolean;
  /** True when it can proceed but the operator is accepting a stated risk. */
  needsAcknowledgement: boolean;
}

export interface InstalledMod {
  source: string;
  modId: string;
  modName: string;
  version: string;
  sha256: string;
  files: string[];
  installedAt: number;
  installedBy: string;
}

/* ---- where a mod's files belong ---------------------------------------- */

export interface GameLayout {
  /** Directory, relative to the server's data root, that mods are unpacked into. */
  modsDirectory: (fullName: string) => string;
  /** Paths proving the loader is present, relative to the data root. */
  loaderMarkers: string[];
  /** Extensions a mod for this game may legitimately contain. */
  allowedExtensions: string[];
}

/**
 * A mod id may contain a slash (Thunderstore's Author/Name), which would turn
 * one directory into two nested ones and leave an empty parent behind on
 * uninstall. Thunderstore's own full_name form uses a hyphen; follow it.
 */
function directoryName(modId: string): string {
  return modId.replace(/[/\\]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_');
}

const LAYOUTS: Record<string, GameLayout> = {
  satisfactory: {
    // SML loads every directory under Mods/ by its mod reference.
    modsDirectory: (fullName) => `FactoryGame/Mods/${directoryName(fullName)}`,
    loaderMarkers: ['FactoryGame/Mods/SML'],
    allowedExtensions: [
      '.pak', '.sig', '.ucas', '.utoc', '.so', '.dll', '.json', '.uplugin',
      '.txt', '.md', '.png', '.jpg', '.cfg', '.ini', '(none)',
      // Unreal Engine ships these beside every packaged plugin. Flagging them
      // would warn on literally every Satisfactory mod, which trains an
      // operator to click past the warnings that do mean something.
      '.sym', '.debug', '.modules', '.uasset', '.umap', '.uexp', '.ubulk', '.res',
    ],
  },
  valheim: {
    // BepInEx scans plugins/ recursively; one directory per package keeps an
    // uninstall unambiguous.
    modsDirectory: (fullName) => `BepInEx/plugins/${directoryName(fullName)}`,
    loaderMarkers: ['BepInEx/core', '.doorstop_version'],
    allowedExtensions: [
      '.dll', '.json', '.txt', '.md', '.png', '.jpg', '.cfg', '.xml', '.yml',
      '.yaml', '.assets', '.bundle', '.manifest', '(none)',
    ],
  },
};

export function layoutFor(gameType: string | undefined): GameLayout | null {
  return gameType ? (LAYOUTS[gameType] ?? null) : null;
}

/* ---- the checks --------------------------------------------------------- */

function sha256Of(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Compares against the publisher's own hash. A mismatch is the one finding
 * that means something is definitely wrong: either the download was tampered
 * with or the repository is inconsistent, and neither is worth installing.
 */
function integrityFinding(expected: string | null, actual: string): Finding {
  if (!expected) {
    return {
      id: 'integrity',
      label: 'Integrity',
      state: 'unknown',
      summary: 'This repository publishes no hash.',
      detail:
        'The download cannot be proven to be exactly what the author uploaded. Its contents were still inspected and scanned.',
    };
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    return {
      id: 'integrity',
      label: 'Integrity',
      state: 'fail',
      summary: 'The download does not match the published hash.',
      detail: `Expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
    };
  }
  return {
    id: 'integrity',
    label: 'Integrity',
    state: 'pass',
    summary: 'Matches the hash published by the repository.',
  };
}

function scanFinding(scans: ScanVerdict[]): Finding {
  const worst = worstState(scans);
  const base = { id: 'malware', label: 'Malware scan' };

  switch (worst) {
    case 'malicious':
      return { ...base, state: 'fail', summary: 'A scanner flagged this file as malicious.' };
    case 'suspicious':
      return { ...base, state: 'warn', summary: 'A scanner flagged this file as suspicious.' };
    case 'error':
      return { ...base, state: 'unknown', summary: 'A scanner could not be reached.' };
    case 'unknown':
      return {
        ...base,
        state: 'warn',
        summary: 'No scanner has seen this exact file before.',
        detail: 'Expected for a fresh release; worth pausing over for an established mod.',
      };
    case 'off':
      return {
        ...base,
        state: 'unknown',
        summary: 'No scanner is configured.',
        detail: 'Add a VirusTotal key or ClamAV address in Settings to have these bytes checked.',
      };
    default:
      return {
        ...base,
        state: 'pass',
        summary: 'No engine reported anything.',
        detail: 'This means no scanner recognised it, not that the code is safe.',
      };
  }
}

/** Flags file types that have no business in a mod for this game. */
function contentFinding(report: ArchiveReport, layout: GameLayout): Finding {
  const unexpected = Object.keys(report.extensions).filter(
    (ext) => !layout.allowedExtensions.includes(ext),
  );

  if (unexpected.length === 0) {
    return {
      id: 'content',
      label: 'Contents',
      state: 'pass',
      summary: `${report.files} files, all of expected types.`,
    };
  }
  return {
    id: 'content',
    label: 'Contents',
    state: 'warn',
    summary: `Contains unexpected file types: ${unexpected.slice(0, 6).join(', ')}.`,
    detail:
      'Not proof of anything, but a mod for this game does not normally ship these. Read the mod page before continuing.',
  };
}

/* ---- compatibility ------------------------------------------------------ */

export interface InstalledState {
  /** Mod id to version, for everything this portal installed. */
  versions: Record<string, string>;
  /** Whether the game's mod loader is present on disk. */
  loaderPresent: boolean;
}

function compatibilityFindings(
  version: ModVersion,
  source: ModSource,
  installed: InstalledState,
): Finding[] {
  const findings: Finding[] = [];

  if (source.loader) {
    findings.push(
      installed.loaderPresent
        ? {
            id: 'loader',
            label: source.loader.label,
            state: 'pass',
            summary: 'Installed on this server.',
          }
        : {
            id: 'loader',
            label: source.loader.label,
            state: 'fail',
            summary: `${source.loader.label} is not installed, so this mod would never load.`,
            detail: `Install ${source.loader.label} first.`,
          },
    );
  }

  for (const dependency of version.dependencies) {
    // The loader appears in dependency lists too; it already has its own row.
    if (source.loader && dependency.id === source.loader.id) continue;

    const have = installed.versions[dependency.id];
    const label = `Requires ${dependency.id}`;

    if (!have) {
      findings.push({
        id: `dep:${dependency.id}`,
        label,
        state: dependency.optional ? 'warn' : 'fail',
        summary: dependency.optional
          ? 'Optional dependency, not installed.'
          : 'Required dependency is not installed.',
        detail: dependency.range ? `Needs ${dependency.range}.` : undefined,
      });
      continue;
    }

    if (!dependency.range) {
      findings.push({
        id: `dep:${dependency.id}`,
        label,
        state: 'pass',
        summary: `Installed (${have}).`,
      });
      continue;
    }

    const ok = satisfies(have, dependency.range);
    findings.push({
      id: `dep:${dependency.id}`,
      label,
      state: ok === null ? 'unknown' : ok ? 'pass' : 'fail',
      summary:
        ok === null
          ? `Installed ${have}; could not read the requirement "${dependency.range}".`
          : ok
            ? `Installed ${have}, satisfies ${dependency.range}.`
            : `Installed ${have}, but ${dependency.range} is required.`,
    });
  }

  return findings;
}

/* ---- the engine --------------------------------------------------------- */

export function createModInstaller(dockerClient: DockerClient) {
  const { docker } = dockerClient;
  const helpers = createHelperRunner(dockerClient);

  async function download(url: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': 'Gamekeep' },
      });
    } catch (err) {
      throw new ModSourceError(`Download failed: ${(err as Error).message}`, 'download-failed');
    }
    if (!response.ok) {
      throw new ModSourceError(`Download answered ${response.status}.`, 'download-failed');
    }

    // Checked before reading the body as well as after: a declared length
    // saves pulling half a gigabyte to then reject it.
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new ModSourceError('That download is larger than the limit.', 'too-large');
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_DOWNLOAD_BYTES) {
      throw new ModSourceError('That download is larger than the limit.', 'too-large');
    }
    return body;
  }

  /**
   * Everything that can be judged without writing anything. The returned plan
   * carries the downloaded bytes' hash, so the install that follows can prove
   * it is committing what was inspected.
   */
  async function prepare(options: {
    source: ModSource;
    mod: { id: string; name: string; deprecated?: boolean };
    version: ModVersion;
    layout: GameLayout;
    installed: InstalledState;
    scanners: ScannerConfig;
  }): Promise<{ plan: InstallPlan; body: Buffer; entries: ZipEntry[] }> {
    const { source, mod, version, layout, installed, scanners } = options;

    const body = await download(version.downloadUrl);
    const sha256 = sha256Of(body);

    const findings: Finding[] = [integrityFinding(version.sha256, sha256)];

    // The closest thing either repository offers to "is this still looked
    // after". It is not a vulnerability feed -- no such thing exists for game
    // mods -- but an abandoned mod is where unfixed problems accumulate.
    if (mod.deprecated) {
      findings.push({
        id: 'maintenance',
        label: 'Maintenance',
        state: 'warn',
        summary: 'The author marked this mod deprecated.',
        detail:
          'It is no longer maintained, so anything wrong with it will stay wrong. Check the mod page for a successor.',
      });
    }

    // Read and judge the archive before anything else touches it.
    let entries: ZipEntry[];
    let archive: ArchiveReport;
    try {
      entries = readCentralDirectory(body);
      archive = analyse(entries);
      findings.push({
        id: 'archive',
        label: 'Archive safety',
        state: 'pass',
        summary: `${archive.files} files, nothing escapes the mod directory.`,
        detail: `Peak compression ratio ${archive.peakRatio.toFixed(1)}x.`,
      });
    } catch (err) {
      const archiveError = err instanceof ArchiveError ? err : null;
      return {
        body,
        entries: [],
        plan: {
          source: source.id,
          modId: mod.id,
          modName: mod.name,
          version: version.version,
          sha256,
          sizeBytes: body.length,
          targetDirectory: layout.modsDirectory(mod.id),
          fileCount: 0,
          archive: { entries: 0, files: 0, totalBytes: 0, compressedBytes: 0, peakRatio: 0, extensions: {} },
          scans: [],
          findings: [
            ...findings,
            {
              id: 'archive',
              label: 'Archive safety',
              state: 'fail',
              summary: archiveError?.message ?? (err as Error).message,
              detail: archiveError?.entry ? `Entry: ${archiveError.entry}` : undefined,
            },
          ],
          installable: false,
          needsAcknowledgement: false,
        },
      };
    }

    const scans = await runScanners(body, sha256, scanners);
    findings.push(scanFinding(scans));
    findings.push(contentFinding(archive, layout));
    findings.push(...compatibilityFindings(version, source, installed));

    const failed = findings.some((f) => f.state === 'fail');
    const uncertain = findings.some((f) => f.state === 'warn' || f.state === 'unknown');

    return {
      body,
      entries,
      plan: {
        source: source.id,
        modId: mod.id,
        modName: mod.name,
        version: version.version,
        sha256,
        sizeBytes: body.length,
        targetDirectory: layout.modsDirectory(mod.id),
        fileCount: archive.files,
        archive,
        scans,
        findings,
        installable: !failed,
        needsAcknowledgement: uncertain,
      },
    };
  }

  /**
   * Writes the mod. Called only with a plan that passed, and re-checks the
   * bytes against that plan so a commit can never install something other
   * than what was inspected.
   */
  async function commit(
    server: ServerConfig,
    dataRoot: string,
    plan: InstallPlan,
    body: Buffer,
    entries: ZipEntry[],
  ): Promise<string[]> {
    if (sha256Of(body) !== plan.sha256) {
      throw new ModSourceError('The download changed between inspection and install.', 'mismatch');
    }

    const written: string[] = [];
    const files: TarEntry[] = [];
    /*
     * Every directory is named explicitly, shallowest first. Docker will
     * happily create the intermediate directories of a nested path itself, but
     * it creates them as root -- so a mod ends up with its files owned
     * correctly inside directories the game user does not own.
     */
    const directories = new Set<string>();
    // Including the mod directory's own ancestors, for the same reason: on a
    // first install "FactoryGame/Mods" does not exist yet either.
    const parts = plan.targetDirectory.split('/');
    for (let i = 0; i < parts.length; i++) directories.add(parts.slice(0, i + 1).join('/'));

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const content = extractEntry(body, entry);
      const path = `${plan.targetDirectory}/${entry.name}`;

      const segments = path.split('/');
      for (let i = plan.targetDirectory.split('/').length; i < segments.length - 1; i++) {
        directories.add(segments.slice(0, i + 1).join('/'));
      }

      files.push({ name: path, content });
      written.push(path);
    }

    const tar: TarEntry[] = [
      ...[...directories]
        .sort((a, b) => a.split('/').length - b.split('/').length)
        .map((name) => ({ name, content: Buffer.alloc(0), directory: true })),
      ...files,
    ];

    // Written as whoever owns the game's own files rather than as root: these
    // images run the server as an unprivileged user, and a mod it cannot read
    // or write its config into is a mod that does not work.
    const owner = await ownerOf(server.container, dataRoot);

    // One push, so the mod appears whole or not at all.
    await docker
      .getContainer(server.container)
      .putArchive(Readable.from(buildTarEntries(tar, owner)), { path: dataRoot });
    return written;
  }

  /**
   * Who owns the game's files. Falls back to root only if the question cannot
   * be answered, which is the same behaviour as before this was asked at all.
   */
  async function ownerOf(container: string, path: string): Promise<{ uid: number; gid: number }> {
    try {
      const out = await helpers.run(container, ['stat', '-c', '%u %g', path], 20_000);
      const [uid, gid] = out.trim().split(/\s+/).map(Number);
      if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid: uid!, gid: gid! };
    } catch {
      // Falls through to the default below.
    }
    return { uid: 0, gid: 0 };
  }

  /**
   * Whether a path exists inside the container. Used to detect a mod loader
   * that was installed by hand, which disk knows about and our records do not.
   */
  async function exists(container: string, path: string): Promise<boolean> {
    try {
      await helpers.run(container, ['test', '-e', path], 20_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes the directory recorded at install time, and nothing else.
   *
   * The path is rebuilt from the layout rather than taken from a request, and
   * passed as an argv array: this is an "rm -rf" against a game server's data,
   * so there must be no way for a client-supplied string to reach it.
   */
  async function remove(server: ServerConfig, dataRoot: string, directory: string): Promise<void> {
    if (directory.includes('..') || directory.startsWith('/')) {
      throw new ModSourceError('Refusing to remove that path.', 'bad-path');
    }
    const target = `${dataRoot.replace(/\/$/, '')}/${directory}`;
    await helpers.run(server.container, ['rm', '-rf', '--', target]);
  }

  return { prepare, commit, remove, exists };
}

export type ModInstaller = ReturnType<typeof createModInstaller>;
