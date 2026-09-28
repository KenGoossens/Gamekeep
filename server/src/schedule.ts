import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { Db, ScheduleRow } from './db.js';
import type { ServerRegistry } from './registry.js';
import type { DockerClient } from './docker/client.js';
import type { createActionRunner } from './docker/actions.js';
import type { GameQuery } from './query/gamedig.js';

/**
 * Actions that run themselves.
 *
 * The standing request behind every game panel: restart the server at five in
 * the morning, when the memory leak has had its day and nobody is on. This is
 * deliberately not cron. A schedule is a time of day plus the days it applies,
 * because that is the entire vocabulary the job needs, and a cron string in a
 * friends-and-family portal is a support question waiting to happen.
 *
 * Two rules keep it from doing damage on its own:
 *
 * - A scheduled restart never starts a server that is stopped. Someone
 *   switched that server off on purpose, and "the machine turned it back on
 *   at 05:00" is exactly the surprise this portal exists to prevent. Starting
 *   is its own action for whoever really wants it.
 * - "Skip when players are online" is checked against a fresh query at the
 *   moment of truth, not a cached count -- which the portal can do and most
 *   panels cannot, because it already knows how to ask the game.
 *
 * Runs go through the same action runner as a button press, so verification,
 * cooldown, audit and Discord all apply unchanged; the actor is simply the
 * schedule instead of a person.
 */

/**
 * The next moment this schedule should fire, strictly after `from`.
 *
 * Walked in local calendar days rather than by adding 86400000, so a DST
 * shift moves the clock and not the schedule: "05:00" stays 05:00 on the
 * wall, which is what a person setting it means.
 */
export function nextRun(time: string, days: number[], from: Date): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= from.getTime()) continue;
    if (days.length > 0 && !days.includes(candidate.getDay())) continue;
    return candidate.getTime();
  }
  // Unreachable with a valid day list: eight offsets cover a whole week.
  return null;
}

const TICK_MS = 30_000;

export function createScheduler(deps: {
  db: Db;
  registry: ServerRegistry;
  actions: ReturnType<typeof createActionRunner>;
  docker: DockerClient;
  gameQuery: GameQuery;
  /**
   * Runs a backup and resolves to a short description of what was made.
   * Wired in by the backup service; a schedule created before that exists
   * reports the absence rather than pretending.
   */
  backup?: (server: ServerConfig, actor: string) => Promise<string>;
  log: (message: string) => void;
}) {
  const { db, registry, actions, docker, gameQuery, log } = deps;

  /** Which schedule is waiting on which job, so its row can show the outcome. */
  const watching = new Map<string, string>();

  actions.setOnSettled((job) => {
    const scheduleId = watching.get(job.id);
    if (!scheduleId) return;
    watching.delete(job.id);
    const outcome =
      job.phase === 'done'
        ? `Done: the ${job.action} completed.`
        : job.containerRestarted
          ? 'The container came back, but the game never answered.'
          : `Failed: ${job.error ?? 'the action did not complete.'}`;
    db.noteScheduleResult(scheduleId, outcome);
  });

  function planNext(schedule: ScheduleRow): number | null {
    return nextRun(schedule.time, schedule.days, new Date());
  }

  async function runOne(schedule: ScheduleRow): Promise<void> {
    const next = planNext(schedule);
    const finish = (result: string) => {
      db.recordScheduleRun(schedule.id, {
        lastRunAt: Date.now(),
        lastResult: result,
        nextRunAt: next,
      });
    };

    const server = registry.get(schedule.serverId);
    if (!server) {
      // Left enabled and said plainly: the row is the operator's to delete,
      // and silently disabling it would hide why nothing happens.
      finish('Skipped: this server no longer exists.');
      return;
    }

    if (actions.activeJobFor(server.id)) {
      finish('Skipped: another action was already running.');
      return;
    }

    const status = await docker.getStatus(server);
    if (schedule.action === 'restart' && !status.running) {
      finish('Skipped: the server was stopped. A schedule never turns a stopped server back on.');
      return;
    }
    if (schedule.action === 'stop' && !status.running) {
      finish('Nothing to do: already stopped.');
      return;
    }
    if (schedule.action === 'start' && status.running) {
      finish('Nothing to do: already running.');
      return;
    }

    // Only for the disruptive actions: a backup does not kick anyone, and a
    // nightly backup that skips because two night owls are on is no backup.
    const disruptive = schedule.action === 'restart' || schedule.action === 'stop';
    if (schedule.skipOccupied && disruptive && status.running) {
      // A fresh answer, not the cache: this is the one moment it matters.
      gameQuery.invalidate(server.id);
      const players = await gameQuery.getPlayers(server);
      if (players && players.online > 0) {
        finish(
          `Skipped: ${players.online} ${players.online === 1 ? 'player is' : 'players are'} online.`,
        );
        return;
      }
    }

    const actor = `schedule “${schedule.name}”`;

    if (schedule.action === 'backup') {
      if (!deps.backup) {
        finish('Skipped: backups are not available in this build.');
        return;
      }
      finish('Backing up…');
      try {
        const summary = await deps.backup(server, actor);
        db.noteScheduleResult(schedule.id, `Done: ${summary}`);
      } catch (err) {
        db.noteScheduleResult(schedule.id, `Failed: ${(err as Error).message}`);
      }
      return;
    }

    const outcome = actions.start(server, { userId: '', username: actor }, schedule.action);
    if (!outcome.ok) {
      finish('Skipped: another action got there first.');
      return;
    }
    gameQuery.invalidate(server.id);
    docker.invalidate(server);
    watching.set(outcome.job.id, schedule.id);
    finish(`Running the ${schedule.action}…`);
    log(`schedule "${schedule.name}" started a ${schedule.action} of ${server.id}`);
  }

  function tick(): void {
    for (const schedule of db.dueSchedules(Date.now())) {
      void runOne(schedule).catch((err: unknown) => {
        db.noteScheduleResult(schedule.id, `Failed: ${(err as Error).message}`);
        log(`schedule "${schedule.name}" failed: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Recomputes every next-run from now. Called at boot on purpose: a run
   * missed while the portal was down is skipped, not fired late -- a 05:00
   * restart landing at 14:00 because the portal rebooted is worse than a
   * missed one.
   */
  function reschedule(): void {
    for (const schedule of db.allSchedules()) {
      db.setScheduleNextRun(schedule.id, schedule.enabled ? planNext(schedule) : null);
    }
  }

  let timer: NodeJS.Timeout | null = null;

  function start(): void {
    reschedule();
    timer = setInterval(tick, TICK_MS);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Lets the backup service plug itself in once it exists. */
  function setBackupRunner(fn: NonNullable<typeof deps.backup>): void {
    deps.backup = fn;
  }

  return { start, stop, tick, planNext, setBackupRunner, newId: () => randomUUID() };
}

export type Scheduler = ReturnType<typeof createScheduler>;
