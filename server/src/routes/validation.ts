import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { ValidationTarget } from '../validation.js';
import { originOf } from '../auth/origin.js';

/**
 * Validation Runs, owner-only: this deploys real servers (and real downloads)
 * on the owner's machine, one app at a time, and tears everything down. The
 * audience is the person who answers for the box and the bandwidth — nobody
 * below owner gets the button.
 */
/** Every target in one run is a full from-scratch download; a list needs an end. */
const MAX_TARGETS = 50;
const MAX_ID_LENGTH = 128;

/**
 * One parser for both the run and the schedule bodies — the same shape must
 * never be interpreted two ways — with caps on count and id length.
 */
function parseTargets(body: {
  apps?: string[];
  steam?: Array<{ appId?: number; name?: string }>;
}): ValidationTarget[] {
  const targets: ValidationTarget[] = [
    ...(Array.isArray(body?.apps)
      ? body.apps
          .filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= MAX_ID_LENGTH)
          .map((id) => ({ kind: 'catalog' as const, id }))
      : []),
    ...(Array.isArray(body?.steam)
      ? body.steam
          .filter((s) => Number.isInteger(Number(s?.appId)) && Number(s?.appId) > 0)
          .map((s) => ({
            kind: 'steam' as const,
            appId: Number(s.appId),
            name: typeof s.name === 'string' ? s.name.slice(0, 80) : undefined,
          }))
      : []),
  ];
  return targets.slice(0, MAX_TARGETS);
}

export function registerValidationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { validation, db, guard } = ctx;
  const owner = { preHandler: guard.requireOwner };

  app.get('/api/validation', owner, async (_request, reply) => {
    return reply.send(validation.state());
  });

  app.post<{ Body: { apps?: string[]; steam?: Array<{ appId?: number; name?: string }> } }>(
    '/api/validation/run',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const targets = parseTargets(request.body ?? {});
      try {
        const run = validation.start(targets, user.username);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'validation-run',
          result: 'success',
          detail: `Started: ${run.apps.length} app(s)`,
          ...originOf(request),
        });
        return reply.code(201).send({ run });
      } catch (err) {
        return reply.code(409).send({ error: 'cannot-start', message: (err as Error).message });
      }
    },
  );

  /**
   * The standing instruction: run a saved selection at a set time on set
   * days. Null disables and forgets it. Same clock rules as every schedule:
   * portal time, a missed run stays missed, never stacks on a running one.
   */
  app.put<{
    Body: {
      schedule: null | {
        enabled?: boolean;
        time?: string;
        days?: number[];
        apps?: string[];
        steam?: Array<{ appId?: number; name?: string }>;
      };
    };
  }>('/api/validation/schedule', owner, async (request, reply) => {
    const user = request.user!;
    const body = request.body?.schedule;
    if (body === null) {
      validation.setSchedule(null);
      db.audit({
        userId: user.id, username: user.username, serverId: null,
        action: 'validation-run', result: 'success',
        detail: 'Schedule removed', ...originOf(request),
      });
      return reply.send({ schedule: null });
    }
    const time = String(body?.time ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return reply.code(400).send({ error: 'bad-time', message: 'Time must be HH:MM, 24-hour.' });
    }
    const days = Array.isArray(body?.days)
      ? [...new Set(body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [];
    if (days.length === 0) {
      return reply.code(400).send({ error: 'bad-days', message: 'Pick at least one day.' });
    }
    const targets = parseTargets(body ?? {});
    if (targets.length === 0) {
      return reply.code(400).send({ error: 'no-targets', message: 'Pick at least one app for the schedule.' });
    }
    const schedule = { enabled: body?.enabled !== false, time, days, targets };
    validation.setSchedule(schedule);
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'validation-run', result: 'success',
      detail: `Schedule set: ${targets.length} app(s) at ${time} on ${days.length} day(s)`,
      ...originOf(request),
    });
    return reply.send({ schedule: validation.schedule() });
  });

  app.post('/api/validation/cancel', owner, async (request, reply) => {
    const user = request.user!;
    const cancelled = validation.cancel();
    if (cancelled) {
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: null,
        action: 'validation-run',
        result: 'success',
        detail: 'Cancelled: the current app finishes its teardown, the rest are skipped',
        ...originOf(request),
      });
    }
    return reply.send({ cancelled });
  });
}
