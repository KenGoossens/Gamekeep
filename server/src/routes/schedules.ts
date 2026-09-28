import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { nextRun } from '../schedule.js';
import type { ScheduleAction, ScheduleRow } from '../db.js';

/**
 * Managing schedules is operator work: a schedule is a standing instruction
 * that keeps acting after everyone has gone to bed, which is more trust than a
 * single button press, not less.
 *
 * Times are validated here and interpreted by the scheduler in the portal's
 * own time zone. That zone is included in every listing rather than assumed:
 * a container without TZ set runs in UTC, and "05:00" meaning 05:00 UTC is
 * exactly the kind of surprise that should be visible before it happens.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PER_SERVER = 10;
const MAX_NAME = 60;

const ACTIONS: ScheduleAction[] = ['restart', 'start', 'stop', 'backup'];

interface ScheduleBody {
  name?: string;
  action?: string;
  time?: string;
  days?: unknown;
  skipOccupied?: boolean;
  enabled?: boolean;
}

function parseDays(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const days = [...new Set(raw)].filter(
    (d): d is number => Number.isInteger(d) && d >= 0 && d <= 6,
  );
  if (days.length !== new Set(raw).size) return null;
  return days.sort((a, b) => a - b);
}

function publicRow(row: ScheduleRow) {
  return {
    id: row.id,
    name: row.name,
    action: row.action,
    time: row.time,
    days: row.days,
    skipOccupied: row.skipOccupied,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastResult: row.lastResult,
  };
}

export function registerScheduleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, db, guard, scheduler } = ctx;
  const operator = { preHandler: guard.requireServerOperator };

  function describe(row: { action: string; time: string; days: number[]; name: string }): string {
    const days =
      row.days.length === 0
        ? 'every day'
        : row.days.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(',');
    return `"${row.name}": ${row.action} at ${row.time}, ${days}`;
  }

  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/schedules',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const now = new Date();
      return reply.send({
        schedules: db.listSchedules(server.id).map(publicRow),
        actions: ACTIONS,
        /*
         * Both halves of "when is 05:00": which zone this portal's clock is
         * in, and what its clock says right now. A container without TZ runs
         * in UTC, and showing that beats letting someone find out at 05:00
         * their time when nothing happens.
         */
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        serverTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: ScheduleBody }>(
    '/api/servers/:id/schedules',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      if (db.countSchedules(server.id) >= MAX_PER_SERVER) {
        return reply.code(409).send({
          error: 'too-many',
          message: `This server already has ${MAX_PER_SERVER} schedules. Remove one first.`,
        });
      }

      const body = request.body ?? {};
      const action = String(body.action ?? '');
      if (!ACTIONS.includes(action as ScheduleAction)) {
        return reply.code(400).send({ error: 'bad-action', message: 'Choose what the schedule should do.' });
      }
      const time = String(body.time ?? '');
      if (!TIME.test(time)) {
        return reply.code(400).send({ error: 'bad-time', message: 'Time must be HH:MM, e.g. 05:00.' });
      }
      const days = parseDays(body.days);
      if (days === null) {
        return reply.code(400).send({ error: 'bad-days', message: 'Days must be week days.' });
      }

      const name = (body.name ?? '').trim().slice(0, MAX_NAME) || `${action} at ${time}`;
      const row = {
        id: scheduler.newId(),
        serverId: server.id,
        name,
        action: action as ScheduleAction,
        time,
        days,
        // Defaults to considerate: whoever wants a restart that kicks players
        // mid-session can switch it off, but they do it on purpose.
        skipOccupied: body.skipOccupied !== false,
        enabled: body.enabled !== false,
        createdBy: user.id,
        nextRunAt: body.enabled !== false ? nextRun(time, days, new Date()) : null,
      };
      db.addSchedule(row);

      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'schedule-created',
        result: 'success',
        detail: describe(row),
        ...originOf(request),
      });

      return reply.code(201).send({ schedule: publicRow(db.getSchedule(row.id)!) });
    },
  );

  app.patch<{ Params: { id: string; scheduleId: string }; Body: ScheduleBody }>(
    '/api/servers/:id/schedules/:scheduleId',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const existing = db.getSchedule(request.params.scheduleId);
      // The server id in the path must own the schedule: a valid schedule id
      // must not be reachable through some other server's URL.
      if (!existing || existing.serverId !== server.id) {
        return reply.code(404).send({ error: 'unknown-schedule' });
      }

      const body = request.body ?? {};
      const action = body.action === undefined ? existing.action : String(body.action);
      if (!ACTIONS.includes(action as ScheduleAction)) {
        return reply.code(400).send({ error: 'bad-action', message: 'Choose what the schedule should do.' });
      }
      const time = body.time === undefined ? existing.time : String(body.time);
      if (!TIME.test(time)) {
        return reply.code(400).send({ error: 'bad-time', message: 'Time must be HH:MM, e.g. 05:00.' });
      }
      const days = body.days === undefined ? existing.days : parseDays(body.days);
      if (days === null) {
        return reply.code(400).send({ error: 'bad-days', message: 'Days must be week days.' });
      }

      const updated = {
        id: existing.id,
        name: (body.name ?? existing.name).trim().slice(0, MAX_NAME) || existing.name,
        action: action as ScheduleAction,
        time,
        days,
        skipOccupied: body.skipOccupied ?? existing.skipOccupied,
        enabled: body.enabled ?? existing.enabled,
        nextRunAt: null as number | null,
      };
      updated.nextRunAt = updated.enabled ? nextRun(updated.time, updated.days, new Date()) : null;
      db.updateSchedule(updated);

      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'schedule-changed',
        result: 'success',
        detail: `${describe({ ...updated, name: updated.name })}${updated.enabled ? '' : ' (disabled)'}`,
        ...originOf(request),
      });

      return reply.send({ schedule: publicRow(db.getSchedule(existing.id)!) });
    },
  );

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    '/api/servers/:id/schedules/:scheduleId',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const existing = db.getSchedule(request.params.scheduleId);
      if (!existing || existing.serverId !== server.id) {
        return reply.code(404).send({ error: 'unknown-schedule' });
      }

      db.removeSchedule(existing.id);
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'schedule-removed',
        result: 'success',
        detail: describe(existing),
        ...originOf(request),
      });
      return reply.send({ removed: existing.id });
    },
  );
}
