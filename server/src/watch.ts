import type { ActionRunner } from './docker/actions.js';
import type { DockerClient } from './docker/client.js';
import { notifyServer, type Notifier } from './notify.js';
import type { ServerRegistry } from './registry.js';

/**
 * Noticing that a server fell over.
 *
 * The distinction this has to make is between a server someone switched off
 * and one that died, because only the second is worth waking anyone for. A
 * deliberate stop always has a job behind it, so a transition to stopped with
 * no job in flight and none just finished is the interesting case.
 *
 * It also reports the recovery, which is not politeness: a message saying a
 * server went down, with nothing after it, leaves you wondering for the rest
 * of the evening.
 */

const INTERVAL_MS = 30_000;
/**
 * How long after an action a stop still counts as intentional. A stop job
 * settles the moment the container is down, but the poll that sees it may be
 * most of a cycle later.
 */
const GRACE_MS = 3 * 60_000;

/**
 * The bits a notification needs to show the game rather than just name it.
 * Shared with every other sender so no two of them drift apart.
 */
const art = notifyServer;

export function createWatcher(deps: {
  registry: ServerRegistry;
  docker: DockerClient;
  actions: ActionRunner;
  notify: Notifier;
  lastActionAt: (serverId: string) => number | null;
}) {
  /** Servers this watcher reported as down, so only those get a recovery. */
  const announcedDown = new Set<string>();
  /** Last known running state per server; absent until the first look. */
  const running = new Map<string, boolean>();

  async function tick(): Promise<void> {
    for (const server of deps.registry.list()) {
      let isRunning: boolean;
      try {
        isRunning = (await deps.docker.getStatus(server)).running;
      } catch {
        // A Docker hiccup is not a server going down; say nothing.
        continue;
      }

      const was = running.get(server.id);
      running.set(server.id, isRunning);

      // The first pass only learns the current state. Reporting on it would
      // announce every stopped server each time the portal restarts.
      if (was === undefined || was === isRunning) continue;

      if (isRunning) {
        /*
         * Only for a server this actually reported as down. Someone pressing
         * start already produces its own message, and answering that with
         * "server is back" says the same thing twice -- and calls a deliberate
         * start a recovery, which it was not.
         */
        if (announcedDown.delete(server.id)) {
          deps.notify.send({ kind: 'server-recovered', server: art(server) });
        }
        continue;
      }

      const job = deps.actions.activeJobFor(server.id);
      const recent = deps.lastActionAt(server.id);
      const expected = Boolean(job) || (recent !== null && Date.now() - recent < GRACE_MS);
      if (expected) continue;

      announcedDown.add(server.id);
      deps.notify.send({ kind: 'server-down', server: art(server) });
    }
  }

  function start(): NodeJS.Timeout {
    void tick();
    const timer = setInterval(() => void tick(), INTERVAL_MS);
    timer.unref();
    return timer;
  }

  return { start, tick };
}
