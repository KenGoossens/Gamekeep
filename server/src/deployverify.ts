import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import type { GameQuery } from './query/gamedig.js';
import { gameByQueryType } from './games.js';

/**
 * Deploy Verification: the phase after a deploy starts the container, in
 * which the first boot is followed until the game proves it is up — and the
 * outcome is reported as what it is.
 *
 * Three honest endings:
 * - 'success'     — the game answered, and where it reports a name, with the
 *                   name it was configured with. The configuration landed.
 * - 'unconfirmed' — the container runs but full proof never arrived: the game
 *                   stayed silent past every deadline, or answered under a
 *                   different name. Slow is never failure, and a wrong name
 *                   is news, not a verdict.
 * - 'failed'      — the container died. That one is a verdict.
 *
 * The deadline is the part built for first boots: a SteamCMD game downloads
 * tens of gigabytes before it can say hello, so past the game's own startup
 * budget the watcher keeps waiting AS LONG AS THE DOWNLOAD DEMONSTRABLY
 * PROGRESSES (network-receive and disk-write counters still moving), up to an
 * absolute ceiling. A stalled container stops earning extensions.
 */

export type WatchPhase = 'starting' | 'first-boot' | 'waiting-game' | 'settled';
export type WatchOutcome = 'success' | 'unconfirmed' | 'failed';

export interface DeployWatch {
  id: string;
  serverId: string;
  phase: WatchPhase;
  /** Live, human-readable progress line for the deploy screen. */
  message: string;
  outcome: WatchOutcome | null;
  /** The explanation that ships with the outcome — the honest part. */
  note: string | null;
  startedAt: number;
  settledAt: number | null;
}

/** How long a game may stay silent past its budget with nothing moving. */
const STALL_MS = 5 * 60_000;
/** Nobody waits longer than this, however lively the download looks. */
const CEILING_MS = 60 * 60_000;
const POLL_MS = 5_000;
const WATCH_RETENTION_MS = 30 * 60_000;
/** Counter movement below this per poll window is noise, not a download. */
const PROGRESS_BYTES = 256 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Case-insensitive "the configured name is in there" — games add suffixes. */
const nameMatches = (expected: string, reported: string): boolean => {
  const a = expected.trim().toLowerCase();
  const b = reported.trim().toLowerCase();
  return a.length > 0 && (b.includes(a) || a.includes(b));
};

/** Injected by tests; production always runs the defaults. */
export interface WatchTiming {
  stallMs?: number;
  ceilingMs?: number;
  pollMs?: number;
}

export function createDeployWatcher(
  dockerClient: DockerClient,
  gameQuery: GameQuery,
  timing: WatchTiming = {},
) {
  const { docker } = dockerClient;
  const stallMs = timing.stallMs ?? STALL_MS;
  const ceilingMs = timing.ceilingMs ?? CEILING_MS;
  const pollMs = timing.pollMs ?? POLL_MS;
  const watches = new Map<string, DeployWatch>();
  const onSettled: Array<(watch: DeployWatch, server: ServerConfig) => void> = [];

  function getWatch(id: unknown): DeployWatch | undefined {
    return typeof id === 'string' ? watches.get(id) : undefined;
  }

  function watchForServer(serverId: string): DeployWatch | undefined {
    for (const watch of watches.values()) {
      if (watch.serverId === serverId && watch.phase !== 'settled') return watch;
    }
    return undefined;
  }

  /** Network-in plus disk-write, as one "is anything happening" number. */
  async function activityCounter(container: string): Promise<number | null> {
    try {
      const stats = (await docker
        .getContainer(container)
        .stats({ stream: false })) as unknown as {
        networks?: Record<string, { rx_bytes?: number }>;
        blkio_stats?: { io_service_bytes_recursive?: Array<{ op?: string; value?: number }> };
      };
      const rx = Object.values(stats.networks ?? {}).reduce(
        (sum, net) => sum + (net.rx_bytes ?? 0),
        0,
      );
      const written = (stats.blkio_stats?.io_service_bytes_recursive ?? [])
        .filter((row) => (row.op ?? '').toLowerCase() === 'write')
        .reduce((sum, row) => sum + (row.value ?? 0), 0);
      return rx + written;
    } catch {
      return null;
    }
  }

  /** One short TCP connect, resolved either way. */
  const portAccepts = (host: string, port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2000, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });

  async function publishedTcpPorts(container: string): Promise<number[]> {
    try {
      const info = await docker.getContainer(container).inspect();
      return Object.keys(info.HostConfig?.PortBindings ?? {})
        .filter((spec) => spec.endsWith('/tcp'))
        .map((spec) => Number(spec.split('/')[0]))
        .filter((p) => Number.isInteger(p) && p > 0);
    } catch {
      return [];
    }
  }

  async function run(server: ServerConfig, watch: DeployWatch, expectedName: string | null) {
    const budgetMs =
      (server.restartTimeoutSeconds ?? gameByQueryType(server.query?.type)?.startupSeconds ?? 300) *
      1000;
    const start = Date.now();
    const ceiling = start + ceilingMs;

    let lastCounter: number | null = null;
    let lastMovement = start;

    watch.phase = 'first-boot';

    while (Date.now() < ceiling) {
      dockerClient.invalidate(server);
      const status = await dockerClient.getStatus(server);
      if (!status.running) {
        if (status.state === 'exited' || status.state === 'dead') {
          watch.outcome = 'failed';
          watch.note = `The container stopped during its first boot (exit code ${status.exitCode ?? 'unknown'}). Its log usually names the reason — open the server's Logs tab.`;
          return;
        }
        // 'created' or restarting: give it the loop.
      } else {
        // The game itself, asked every poll once the container stands.
        if (server.query) {
          gameQuery.invalidate(server.id);
          const answer = await gameQuery.getPlayers(server);
          if (answer) {
            if (!expectedName || !answer.serverName) {
              watch.outcome = 'success';
              watch.note = expectedName
                ? 'The game answered. It reports no server name over its query protocol, so the name could not be cross-checked.'
                : 'The game answered its query.';
              return;
            }
            if (nameMatches(expectedName, answer.serverName)) {
              watch.outcome = 'success';
              watch.note = `The game answered as "${answer.serverName}" — the configuration landed.`;
              return;
            }
            watch.outcome = 'unconfirmed';
            watch.note =
              `The server answers, but calls itself "${answer.serverName}" instead of "${expectedName}". ` +
              'Its image may not have read the settings it was given — check the Settings tab against the Joining card.';
            return;
          }
          watch.phase = 'waiting-game';
          watch.message = 'Container is up — waiting for the game to answer';
        } else {
          // No query protocol: a listening port is the strongest proof left.
          const ports = await publishedTcpPorts(server.container);
          for (const port of ports) {
            if (await portAccepts(server.container, port)) {
              watch.outcome = 'success';
              watch.note =
                'This game has no query protocol, so the check stops at its port accepting connections — which it does.';
              return;
            }
          }
          watch.phase = 'waiting-game';
          watch.message =
            ports.length > 0
              ? 'Container is up — waiting for the game port to open'
              : 'Container is up — this game publishes nothing the portal can probe';
        }
      }

      // The first-boot rule: past the game's own budget, waiting continues
      // only while the counters say a download is really happening.
      const counter = await activityCounter(server.container);
      if (counter !== null && (lastCounter === null || counter - lastCounter >= PROGRESS_BYTES)) {
        lastMovement = Date.now();
      }
      if (counter !== null) lastCounter = counter;

      const elapsed = Date.now() - start;
      if (elapsed > budgetMs) {
        if (Date.now() - lastMovement > stallMs) {
          watch.outcome = 'unconfirmed';
          watch.note =
            `No answer after ${Math.round(elapsed / 60000)} minutes, and nothing has moved (no download traffic, no disk writes) for ${Math.round(stallMs / 60000)} of them. ` +
            'The container is still running — slow is not broken — but check its Logs tab before telling friends it is up.';
          return;
        }
        watch.message = `First boot still downloading (${Math.round(elapsed / 60000)} min in) — waiting while it progresses`;
      }

      await sleep(pollMs);
    }

    watch.outcome = 'unconfirmed';
    watch.note =
      'An hour in, the game has still not answered, though the container keeps busy. That is beyond any normal first boot — read its Logs tab.';
  }

  /**
   * Starts following one freshly deployed server. Returns the watch the
   * deploy response hands to the UI; the following itself runs detached.
   */
  function start(server: ServerConfig, expectedName: string | null): DeployWatch {
    const watch: DeployWatch = {
      id: randomUUID(),
      serverId: server.id,
      phase: 'starting',
      message: 'Container created — first boot beginning',
      outcome: null,
      note: null,
      startedAt: Date.now(),
      settledAt: null,
    };
    watches.set(watch.id, watch);

    void run(server, watch, expectedName)
      .catch((err: unknown) => {
        // The watcher itself failing is not the server failing.
        watch.outcome = 'unconfirmed';
        watch.note = `Verification could not finish: ${err instanceof Error ? err.message : String(err)}. The server itself may be fine.`;
      })
      .finally(() => {
        watch.phase = 'settled';
        watch.settledAt = Date.now();
        watch.message =
          watch.outcome === 'success'
            ? 'Verified — the game is up'
            : watch.outcome === 'failed'
              ? 'First boot failed'
              : 'Came up without full proof';
        for (const listener of onSettled) {
          try {
            listener(watch, server);
          } catch {
            // One listener's failure must not starve the others.
          }
        }
        setTimeout(() => watches.delete(watch.id), WATCH_RETENTION_MS).unref();
      });

    return watch;
  }

  function setOnSettled(fn: (watch: DeployWatch, server: ServerConfig) => void) {
    onSettled.push(fn);
  }

  return { start, getWatch, watchForServer, setOnSettled };
}

export type DeployWatcher = ReturnType<typeof createDeployWatcher>;
