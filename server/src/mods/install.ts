import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { DockerClient } from '../docker/client.js';
import { createHelperRunner } from '../docker/helper.js';
import { assertRelativePath, safeSegment } from '../paths.js';
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
import { gameByQueryType, type ModLayout } from '../games.js';

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
  /** 'extract' unpacks the archive; 'file' drops it in whole. */
  installMode: 'extract' | 'file';
  /** The name the artefact is written under, in 'file' mode. */
  filename: string;
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

/*
 * The layout lives in the games registry now, beside the query type, so a
 * game cannot be known well enough to report its players but not well enough
 * to take a mod. This re-exports it under the name the installer already
 * used rather than renaming it everywhere.
 */
export type GameLayout = ModLayout;

export function layoutFor(gameType: string | undefined): GameLayout | null {
  return gameByQueryType(gameType)?.mods ?? null;
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
function integrityFinding(
  published: { algo: 'sha256' | 'sha512' | 'sha1'; value: string } | null,
  body: Buffer,
): Finding {
  // Compared under whichever algorithm the publisher used, not ours: hashing
  // the bytes with sha256 and calling a sha512 mismatch a failure would refuse
  // every Modrinth download.
  const expected = published?.value ?? null;
  const actual = published ? createHash(published.algo).update(body).digest('hex') : '';

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
      detail: `Expected ${published!.algo} ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
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

/**
 * The name an artefact is written under in 'file' mode. Sanitised because it
 * comes from the repository, and it becomes a path.
 */
function artefactName(version: ModVersion, modId: string): string {
  const raw = version.filename ?? `${modId}-${version.version}.jar`;
  const base = raw.split(/[/\\]/).pop() ?? raw;
  // One plain segment or nothing: a filename of ".." would be written at the
  // directory's parent, not inside it.
  try {
    return safeSegment(base, 'filename');
  } catch {
    return 'mod.jar';
  }
}

/** Flags file types that have no business in a mod for this game. */
function contentFinding(report: ArchiveReport, layout: GameLayout, filename: string): Finding {
  /*
   * In 'file' mode the archive is the mod, so its own extension is what is
   * judged: checking the .class files inside a .jar against a game's allowed
   * list would warn on every Minecraft mod ever published.
   */
  if (layout.install === 'file') {
    const dot = filename.lastIndexOf('.');
    const ext = dot === -1 ? '(none)' : filename.slice(dot).toLowerCase();
    return layout.allowedExtensions.includes(ext)
      ? {
          id: 'content',
          label: 'Contents',
          state: 'pass',
          summary: `${filename} — ${report.files} entries inside, installed as one file.`,
        }
      : {
          id: 'content',
          label: 'Contents',
          state: 'warn',
          summary: `${filename} is a ${ext} file, which this game does not normally load.`,
        };
  }

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

  /*
   * Reported, not enforced. A Minecraft build states its loader and game
   * versions exactly, but the portal cannot read a running server's own
   * Minecraft version with any confidence -- so this is put in front of the
   * operator as something to match rather than passed off as verified. A mod
   * built for the wrong Minecraft version is the single most common reason a
   * modded server will not start.
   */
  if (version.compatibility) {
    const { loaders, gameVersions } = version.compatibility;
    findings.push({
      id: 'built-for',
      label: 'Built for',
      state: 'unknown',
      summary: `${loaders.join(' / ') || 'any loader'} — ${gameVersions.join(', ') || 'unstated'}`,
      detail:
        'GameKeepr cannot read this server’s own version, so check this matches it. A mod for the wrong version simply will not load.',
    });
  }

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
        headers: { 'user-agent': 'GameKeepr' },
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
   * Everything that can be judged once the bytes are in hand, wherever they
   * came from. Shared between a repository download and an upload so the two
   * cannot drift into checking different things -- the upload path is the one
   * with no publisher behind it, and so the one that needs these most.
   */
  async function judge(options: {
    body: Buffer;
    layout: GameLayout;
    scanners: ScannerConfig;
    sourceId: string;
    modId: string;
    modName: string;
    version: string;
    filename: string;
    /** Decided by the caller: integrity, maintenance, dependencies. */
    extra: Finding[];
  }): Promise<{ plan: InstallPlan; entries: ZipEntry[] }> {
    const { body, layout, scanners, extra } = options;
    const sha256 = sha256Of(body);
    const findings: Finding[] = [...extra];

    const base = {
      source: options.sourceId,
      modId: options.modId,
      modName: options.modName,
      version: options.version,
      sha256,
      sizeBytes: body.length,
      targetDirectory: layout.directory(options.modId),
      installMode: layout.install,
      filename: options.filename,
    };

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
        entries: [],
        plan: {
          ...base,
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
    findings.push(contentFinding(archive, layout, options.filename));

    return {
      entries,
      plan: {
        ...base,
        fileCount: archive.files,
        archive,
        scans,
        findings,
        installable: !findings.some((f) => f.state === 'fail'),
        needsAcknowledgement: findings.some((f) => f.state === 'warn' || f.state === 'unknown'),
      },
    };
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
    const extra: Finding[] = [integrityFinding(version.hash, body)];

    // The closest thing either repository offers to "is this still looked
    // after". It is not a vulnerability feed -- no such thing exists for game
    // mods -- but an abandoned mod is where unfixed problems accumulate.
    if (mod.deprecated) {
      extra.push({
        id: 'maintenance',
        label: 'Maintenance',
        state: 'warn',
        summary: 'The author marked this mod deprecated.',
        detail:
          'It is no longer maintained, so anything wrong with it will stay wrong. Check the mod page for a successor.',
      });
    }
    extra.push(...compatibilityFindings(version, source, installed));

    const { plan, entries } = await judge({
      body,
      layout,
      scanners,
      sourceId: source.id,
      modId: mod.id,
      modName: mod.name,
      version: version.version,
      filename: artefactName(version, mod.id),
      extra,
    });
    return { plan, body, entries };
  }

  /**
   * The same judgement for a file the operator uploaded themselves.
   *
   * Most mods can simply be downloaded from their own site, and for a game
   * whose repository this portal does not speak, that is the only way. What
   * cannot be done here is prove where the file came from: there is no
   * publisher hash to compare against, and the report says so plainly rather
   * than leaving an operator to assume the same checks ran.
   */
  async function prepareUpload(options: {
    filename: string;
    body: Buffer;
    modId: string;
    modName: string;
    layout: GameLayout;
    loader: { id: string; label: string } | null;
    installed: InstalledState;
    scanners: ScannerConfig;
  }): Promise<{ plan: InstallPlan; entries: ZipEntry[] }> {
    const extra: Finding[] = [
      {
        id: 'integrity',
        label: 'Origin',
        state: 'unknown',
        summary: 'Uploaded by hand, so there is nothing to check it against.',
        detail:
          'A mod from a repository can be proven to be exactly what its author published. This one cannot — only that the archive is well-formed and what the scanners make of it.',
      },
    ];

    if (options.loader) {
      extra.push(
        options.installed.loaderPresent
          ? { id: 'loader', label: options.loader.label, state: 'pass', summary: 'Installed on this server.' }
          : {
              id: 'loader',
              label: options.loader.label,
              state: 'fail',
              summary: `${options.loader.label} is not installed, so this mod would never load.`,
            },
      );
    }

    /*
     * An uploaded archive declares no dependencies, so nothing can be checked
     * for them. Said out loud, because its absence would otherwise look like
     * a clean bill of health.
     */
    extra.push({
      id: 'dependencies',
      label: 'Dependencies',
      state: 'unknown',
      summary: 'An uploaded file lists none, so none were checked.',
      detail: 'If this mod needs others, install those too or it will fail to load.',
    });

    return judge({
      body: options.body,
      layout: options.layout,
      scanners: options.scanners,
      sourceId: 'upload',
      modId: options.modId,
      modName: options.modName,
      version: 'uploaded',
      filename: options.filename,
      extra,
    });
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

    /*
     * Checked here as well as where the names were made. The target path is
     * assembled from inputs that arrive through several files -- a repository
     * id, an upload's filename, a layout -- and Docker will honour a ".." in
     * it, so this is the one place every route has to pass through.
     */
    assertRelativePath(plan.targetDirectory, 'mod directory');
    assertRelativePath(plan.filename, 'mod filename');

    const written: string[] = [];
    const files: TarEntry[] = [];

    /*
     * A Minecraft .jar or a Factorio .zip is an archive the game opens itself,
     * so it goes in whole. Unpacking it would leave a directory of class files
     * the server does not load.
     */
    if (plan.installMode === 'file') {
      const path = `${plan.targetDirectory}/${plan.filename}`;
      const owner = await ownerOf(server.container, dataRoot);
      const parts = plan.targetDirectory.split('/');
      const dirs = parts.map((_, i) => parts.slice(0, i + 1).join('/'));

      await docker.getContainer(server.container).putArchive(
        Readable.from(
          buildTarEntries(
            [
              ...dirs.map((name) => ({ name, content: Buffer.alloc(0), directory: true })),
              { name: path, content: body },
            ],
            owner,
          ),
        ),
        { path: dataRoot },
      );
      return [path];
    }

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
  async function remove(
    server: ServerConfig,
    dataRoot: string,
    installed: { directory: string; files: string[] },
    mode: 'extract' | 'file',
  ): Promise<void> {
    const root = dataRoot.replace(/\/$/, '');
    const safe = (path: string): string => {
      if (path.includes('..') || path.startsWith('/')) {
        throw new ModSourceError('Refusing to remove that path.', 'bad-path');
      }
      return `${root}/${path}`;
    };

    /*
     * In 'file' mode the directory is shared -- every Minecraft mod lives in
     * the same mods/ folder -- so removing it would take every other mod with
     * it. Only the exact files recorded at install time are deleted.
     */
    if (mode === 'file') {
      if (installed.files.length === 0) return;
      await helpers.run(server.container, ['rm', '-f', '--', ...installed.files.map(safe)]);
      return;
    }

    await helpers.run(server.container, ['rm', '-rf', '--', safe(installed.directory)]);
  }

  return { prepare, prepareUpload, commit, remove, exists };
}

export type ModInstaller = ReturnType<typeof createModInstaller>;
