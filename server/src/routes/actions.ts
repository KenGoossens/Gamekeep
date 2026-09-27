import type { FastifyInstance } from 'fastify';
import { originOf } from '../auth/origin.js';
import type { AppContext } from '../context.js';
import { canOperate } from '../db.js';

export function registerActionRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, actions, cooldown, db, guard, docker, gameQuery, notify } = ctx;

  // A settled job writes its own audit row: the outcome is only known once the
  // container has actually come back (or failed to).
  actions.setOnSettled((job) => {
    db.audit({
      userId: job.actorUserId,
      username: job.actorUsername,
      serverId: job.serverId,
      action: job.action,
      // A job that got the container back but never heard from the game is
      // recorded distinctly: it still counts toward the cooldown, but it is not
      // a success and must not be shown to anyone as one.
      result: job.phase === 'done' ? 'success' : job.containerRestarted ? 'unconfirmed' : 'failure',
      detail: job.error,
      // Recorded when the job started: by the time it settles the request is
      // long gone.
      ip: job.actorIp,
      userAgent: job.actorUserAgent,
    });

    /*
     * Only the outcomes worth interrupting someone for. A clean restart is
     * the system working, and a channel that pings for those gets muted.
     */
    if (job.phase !== 'done') {
      const server = registry.get(job.serverId);
      notify.send({
        kind: job.containerRestarted ? 'restart-unconfirmed' : 'restart-failed',
        server: server
          ? {
              name: server.displayName,
              id: server.id,
              steamAppId: server.steamAppId,
              iconUrl: server.iconUrl,
            }
          : { name: job.serverId },
        actor: {
          username: job.actorUsername,
          // Looked up now rather than captured with the job: a role can
          // change while a restart is still running.
          role: job.actorUserId ? (db.findById(job.actorUserId)?.role ?? undefined) : undefined,
        },
        detail: job.containerRestarted
          ? 'The container came back, but the game never answered.'
          : (job.error ?? undefined),
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/servers/:id/restart',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const user = request.user!;

      // The only place a client-supplied value is turned into a container, and
      // it can only ever produce a server that is already in servers.json.
      const server = registry.get(request.params.id);
      if (!server) {
        request.log.warn(
          { requestedId: request.params.id, username: user.username },
          'restart requested for an unknown server id',
        );
        return reply.code(404).send({ error: 'unknown-server' });
      }

      const running = actions.activeJobFor(server.id);
      if (running) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: server.updateStrategy,
          result: 'busy',
          detail: `Already restarting (job ${running.id})`,
          ...originOf(request),
        });
        return reply.code(409).send({
          error: 'already-restarting',
          jobId: running.id,
          phase: running.phase,
          message: running.message,
          actor: running.actorUsername,
        });
      }

      const { remainingSeconds } = cooldown.check(server);
      // Operators and owners may override the cooldown; members may not.
      if (remainingSeconds > 0 && !canOperate(user.role)) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: server.updateStrategy,
          result: 'cooldown',
          detail: `${remainingSeconds}s remaining`,
          ...originOf(request),
        });
        return reply
          .code(429)
          .header('retry-after', String(remainingSeconds))
          .send({ error: 'cooldown', retryAfterSeconds: remainingSeconds });
      }

      const outcome = actions.start(server, {
        userId: user.id,
        username: user.username,
        ...originOf(request),
      });
      if (!outcome.ok) {
        return reply.code(409).send({ error: 'already-restarting', jobId: outcome.job.id });
      }

      // The server is about to go away; drop the cached player count so the UI
      // does not show stale players during the restart.
      gameQuery.invalidate(server.id);
      docker.invalidate(server);

      request.log.info(
        { serverId: server.id, jobId: outcome.job.id, username: user.username },
        'restart started',
      );
      return reply.code(202).send({
        jobId: outcome.job.id,
        phase: outcome.job.phase,
        message: outcome.job.message,
      });
    },
  );

  /**
   * Stopping and starting are administrator-only on purpose: restarting is a
   * safe, self-healing action anyone can be trusted with, but leaving a server
   * switched off is not something a guest should be able to do.
   */
  for (const operation of ['start', 'stop'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/servers/:id/${operation}`,
      { preHandler: guard.requireOperator },
      async (request, reply) => {
        const user = request.user!;
        const server = registry.get(request.params.id);
        if (!server) {
          request.log.warn(
            { requestedId: request.params.id, username: user.username, operation },
            'unknown server id',
          );
          return reply.code(404).send({ error: 'unknown-server' });
        }

        const running = actions.activeJobFor(server.id);
        if (running) {
          return reply.code(409).send({ error: 'already-running', jobId: running.id });
        }

        const outcome = actions.start(
          server,
          { userId: user.id, username: user.username, ...originOf(request) },
          operation,
        );
        if (!outcome.ok) {
          return reply.code(409).send({ error: 'already-running', jobId: outcome.job.id });
        }

        gameQuery.invalidate(server.id);
        docker.invalidate(server);
        request.log.info(
          { serverId: server.id, jobId: outcome.job.id, username: user.username, operation },
          `${operation} started`,
        );
        return reply.code(202).send({
          jobId: outcome.job.id,
          phase: outcome.job.phase,
          message: outcome.job.message,
        });
      },
    );
  }

  app.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const job = actions.getJob(request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'unknown-job' });
      return reply.send({
        id: job.id,
        serverId: job.serverId,
        phase: job.phase,
        message: job.message,
        actor: job.actorUsername,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error,
      });
    },
  );
}
