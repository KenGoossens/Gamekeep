import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import { createHelperRunner } from './docker/helper.js';
import { createFileBrowser, dataRootsOf } from './files.js';
import { notifyServer, type Notifier } from './notify.js';
import type { ServerRegistry } from './registry.js';

/**
 * Update detection: does this server's installed build still match what
 * Steam currently ships?
 *
 * The trick that makes this image-agnostic: every SteamCMD-installed server
 * carries its own receipt — steamapps/appmanifest_<appid>.acf — naming the
 * app id and the INSTALLED buildid. Steam's app info (the same source the
 * Steam deploy path already reads) carries the CURRENT public buildid. When
 * they differ, an update exists — and for these images a restart IS the
 * update, because their entrypoints run SteamCMD on every start.
 *
 * Honest by construction: a server without a manifest (a non-Steam game, a
 * hand-built container) reports "cannot tell" rather than "up to date", and
 * a check that could not run says why. Discord hears about a new build ONCE
 * per build, not once per polling round.
 */

export interface UpdateStatus {
  /** The Steam app the volume says is installed. */
  appId: number | null;
  installedBuild: string | null;
  latestBuild: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  /** Why the answer is what it is, when it is not a plain yes/no. */
  note: string | null;
}

const CHECK_INTERVAL_MS = 6 * 3_600_000;
const BOOT_DELAY_MS = 2 * 60_000;
const NOTIFIED_KEY = 'updates.notified';
const INFO_URL = 'https://api.steamcmd.net/v1/info/';

/** Steam's own runtime depots, never the game anyone is waiting on. */
const RUNTIME_APPIDS = new Set([7, 228980, 1007]);

/** One field out of an .acf (Valve's KeyValues text format). */
const acfField = (text: string, key: string): string | null => {
  const match = new RegExp(`"${key}"\\s+"([^"]*)"`, 'i').exec(text);
  return match ? match[1]! : null;
};

export function createUpdateChecker(deps: {
  docker: DockerClient;
  registry: ServerRegistry;
  db: Db;
  notify: Notifier;
  log: (message: string) => void;
}) {
  const { docker, registry, db, notify, log } = deps;
  const helpers = createHelperRunner(docker);
  const files = createFileBrowser(docker);
  const statuses = new Map<string, UpdateStatus>();
  const checking = new Set<string>();

  function notified(): Record<string, string> {
    try {
      return JSON.parse(db.getSetting(NOTIFIED_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** The current public-branch buildid, from the same app info the Steam
   * deploy path reads. Null when the service cannot say. */
  async function latestBuildOf(appId: number): Promise<string | null> {
    try {
      const response = await fetch(`${INFO_URL}${appId}`, {
        headers: { accept: 'application/json', 'user-agent': 'GameKeepr' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        data?: Record<string, { depots?: { branches?: { public?: { buildid?: string } } } }>;
      };
      return payload.data?.[String(appId)]?.depots?.branches?.public?.buildid ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The installed receipt: the game's appmanifest inside the volume.
   *
   * 'absent' and 'error' are different answers on purpose: a helper timeout
   * must never overwrite a known "update available" with a confident "not a
   * Steam game". The search walks only the server's own mounted data roots
   * (never /proc, /sys or a host bind the game was given), one filesystem
   * each — the lesson of a find / that spun every disk on the box.
   */
  async function readManifest(
    server: ServerConfig,
  ): Promise<{ appId: number; build: string } | 'absent' | 'error'> {
    let roots: string[];
    try {
      roots = await dataRootsOf(docker, server);
    } catch {
      return 'absent';
    }

    const paths: string[] = [];
    let searchFailed = false;
    for (const root of roots) {
      try {
        const output = await helpers.run(
          server.container,
          ['find', root, '-xdev', '-maxdepth', '6', '-type', 'f', '-name', 'appmanifest_*.acf', '-print'],
          45_000,
        );
        paths.push(...output.split('\n').map((l) => l.trim()).filter(Boolean));
      } catch {
        // One root failing (a vanished path, a permission oddity) is noted;
        // receipts found in the other roots still count.
        searchFailed = true;
      }
    }

    const candidates = paths.filter((p) => {
      const id = Number(/appmanifest_(\d+)\.acf$/.exec(p)?.[1]);
      return Number.isInteger(id) && !RUNTIME_APPIDS.has(id);
    });
    if (candidates.length === 0) return searchFailed ? 'error' : 'absent';

    // More than one game manifest is rare; the biggest install is the game.
    let best: { appId: number; build: string; size: number } | null = null;
    for (const path of candidates) {
      try {
        const text = await files.readRaw(server, path);
        const appId = Number(acfField(text, 'appid'));
        const build = acfField(text, 'buildid');
        const size = Number(acfField(text, 'SizeOnDisk') ?? 0);
        if (!Number.isInteger(appId) || !build) continue;
        if (!best || size > best.size) best = { appId, build, size };
      } catch {
        continue;
      }
    }
    return best ?? 'error';
  }

  async function checkServer(server: ServerConfig, minIntervalMs = 0): Promise<UpdateStatus> {
    // "Check now" pressed twice, or scripted: the fresh-enough answer is the
    // answer, not a second find through the volume.
    const known = statuses.get(server.id);
    if (minIntervalMs > 0 && known && Date.now() - known.checkedAt < minIntervalMs) {
      return known;
    }
    if (checking.has(server.id)) {
      return known ?? emptyStatus('A check is already running.');
    }
    checking.add(server.id);
    try {
      const status = await docker.getStatus(server);
      if (!status.running) {
        // A stopped container cannot be searched; keep whatever we knew.
        return (
          statuses.get(server.id) ??
          record(server.id, emptyStatus('The server is stopped, so its volume cannot be read.'))
        );
      }

      const manifest = await readManifest(server);
      if (manifest === 'error') {
        // The check failed; the previous verdict stays rather than being
        // overwritten by a confident wrong one.
        const previous = statuses.get(server.id);
        if (previous) return previous;
        return record(server.id, emptyStatus('The volume could not be searched just now; tried again next round.'));
      }
      if (manifest === 'absent') {
        return record(
          server.id,
          emptyStatus('No Steam install receipt in this server — not a SteamCMD-installed game, so there is nothing to compare.'),
        );
      }

      const latest = await latestBuildOf(manifest.appId);
      if (!latest) {
        return record(server.id, {
          appId: manifest.appId,
          installedBuild: manifest.build,
          latestBuild: null,
          updateAvailable: false,
          checkedAt: Date.now(),
          note: 'Steam’s app-info service did not answer; tried again on the next round.',
        });
      }

      const updateAvailable = latest !== manifest.build;
      const result = record(server.id, {
        appId: manifest.appId,
        installedBuild: manifest.build,
        latestBuild: latest,
        updateAvailable,
        checkedAt: Date.now(),
        note: updateAvailable
          ? 'A restart installs it: these servers run SteamCMD on every start.'
          : null,
      });

      // Discord hears about one build once, however often the checker runs.
      if (updateAvailable) {
        const seen = notified();
        if (seen[server.id] !== latest) {
          seen[server.id] = latest;
          db.setSetting(NOTIFIED_KEY, JSON.stringify(seen));
          void notify.send({
            kind: 'update-available',
            server: notifyServer(server),
            detail: `Steam ships build ${latest}; this server runs ${manifest.build}. A restart installs it.`,
          });
        }
      }
      return result;
    } finally {
      checking.delete(server.id);
    }
  }

  const emptyStatus = (note: string): UpdateStatus => ({
    appId: null,
    installedBuild: null,
    latestBuild: null,
    updateAvailable: false,
    checkedAt: Date.now(),
    note,
  });

  function record(serverId: string, status: UpdateStatus): UpdateStatus {
    statuses.set(serverId, status);
    return status;
  }

  async function checkAll() {
    const live = new Set(registry.list().map((s) => s.id));

    // Prune what no longer exists: a stale status would badge a ghost, and a
    // stale notified entry would silence the ping for a re-created server.
    for (const id of [...statuses.keys()]) if (!live.has(id)) statuses.delete(id);
    const seen = notified();
    const pruned = Object.fromEntries(Object.entries(seen).filter(([id]) => live.has(id)));
    if (Object.keys(pruned).length !== Object.keys(seen).length) {
      db.setSetting(NOTIFIED_KEY, JSON.stringify(pruned));
    }

    for (const server of registry.list()) {
      if (server.transient) continue;
      try {
        await checkServer(server);
      } catch (err) {
        log(`update check for ${server.id} failed: ${(err as Error).message}`);
      }
    }
  }

  function get(serverId: string): UpdateStatus | null {
    return statuses.get(serverId) ?? null;
  }

  /** After a restart installed the build, the badge must not linger: the old
   * verdict is dropped and a fresh check runs in the background. */
  function recheckAfterRestart(server: ServerConfig) {
    const known = statuses.get(server.id);
    if (!known?.updateAvailable) return;
    statuses.delete(server.id);
    void checkServer(server).catch(() => undefined);
  }

  /* Same rule as everywhere else: a rejecting timer must not exit the
   * process. Each server is already guarded individually; this covers the
   * bookkeeping around them. */
  const run = () =>
    void checkAll().catch((err: unknown) => log(`update sweep failed: ${(err as Error).message}`));

  function startLoop() {
    setTimeout(run, BOOT_DELAY_MS).unref();
    setInterval(run, CHECK_INTERVAL_MS).unref();
  }

  return { get, checkServer, checkAll, startLoop, recheckAfterRestart };
}

export type UpdateChecker = ReturnType<typeof createUpdateChecker>;

/** Exported for tests: the manifest parsing is the part worth pinning down. */
export const __internals = { acfField };
