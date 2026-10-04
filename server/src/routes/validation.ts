import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';

/**
 * Validation Runs, owner-only: this deploys real servers (and real downloads)
 * on the owner's machine, one game at a time, and tears everything down. The
 * audience is the person who answers for the box and the bandwidth — nobody
 * below owner gets the button.
 */
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
      const targets = [
        ...(Array.isArray(request.body?.apps)
          ? request.body.apps
              .filter((a): a is string => typeof a === 'string')
              .map((id) => ({ kind: 'catalog' as const, id }))
          : []),
        ...(Array.isArray(request.body?.steam)
          ? request.body.steam
              .filter((s) => Number.isInteger(Number(s?.appId)) && Number(s?.appId) > 0)
              .map((s) => ({
                kind: 'steam' as const,
                appId: Number(s.appId),
                name: typeof s.name === 'string' ? s.name.slice(0, 80) : undefined,
              }))
          : []),
      ];
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
        detail: 'Cancelled: the current game finishes its teardown, the rest are skipped',
        ...originOf(request),
      });
    }
    return reply.send({ cancelled });
  });
}
