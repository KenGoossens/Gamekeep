import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { ServerConfig } from '../config.js';
import type { Job } from '../docker/actions.js';

function jobView(job: Job | undefined) {
  if (!job) return null;
  return {
    id: job.id,
    phase: job.phase,
    message: job.message,
    actor: job.actorUsername,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, gameQuery, cooldown, actions, guard, artwork } = ctx;

  async function describe(server: ServerConfig) {
    // Only the Docker status is awaited. The player count is read from cache
    // and refreshed in the background, so an unreachable game server cannot
    // stall the dashboard for everyone else.
    const status = await docker.getStatus(server);
    const players = gameQuery.getPlayersCached(server);
    const { remainingSeconds, lastRestartAt } = cooldown.check(server);

    return {
      id: server.id,
      displayName: server.displayName,
      notes: server.notes ?? null,
      updateStrategy: server.updateStrategy,
      accent: server.accent ?? null,
      // 'poster' is full-bleed Steam art, 'icon' is a logo centred on a tint,
      // 'none' means the UI draws a lettered tile.
      artworkStyle: await artwork.styleFor(server),
      status: {
        state: status.state,
        running: status.running,
        uptimeSeconds: status.uptimeSeconds,
        health: status.health,
        exitCode: status.exitCode,
        error: status.error,
      },
      players: players
        ? { online: players.online, max: players.max, names: players.names, map: players.map }
        : null,
      cooldownSeconds: server.cooldownSeconds,
      cooldownRemaining: remainingSeconds,
      lastRestartAt,
      activeJob: jobView(actions.activeJobFor(server.id)),
    };
  }

  app.get('/api/servers', { preHandler: guard.requireActiveUser }, async (_request, reply) => {
    const list = await Promise.all(registry.list().map(describe));
    return reply.send({ servers: list });
  });

  app.get<{ Params: { id: string } }>(
    '/api/servers/:id',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      // The detail page shows only this server's own history.
      const history = ctx.db
        .recentAudit(200)
        .filter((row) => row.serverId === server.id)
        .slice(0, 25)
        .map((row) => ({
          id: row.id,
          ts: row.ts,
          username: row.username,
          action: row.action,
          result: row.result,
          detail: request.user && request.user.role !== 'member' ? row.detail : null,
        }));

      return reply.send({ server: await describe(server), history });
    },
  );
}
