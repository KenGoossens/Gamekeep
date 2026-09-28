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

  app.get('/api/servers', { preHandler: guard.requireActiveUser }, async (request, reply) => {
    const user = request.user!;
    /*
     * Servers someone was excepted from are absent, not greyed out: a hidden
     * server that still shows its name is not hidden. yourAccess rides along
     * so the UI can size each card's controls to this caller, not to their
     * global role.
     */
    const visible = registry
      .list()
      .map((server) => ({ server, access: guard.accessFor(user, server.id) }))
      .filter(({ access }) => access !== 'none');
    const list = await Promise.all(
      visible.map(async ({ server, access }) => ({
        ...(await describe(server)),
        yourAccess: access,
      })),
    );
    return reply.send({ servers: list });
  });

  app.get<{ Params: { id: string } }>(
    '/api/servers/:id',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const access = guard.accessFor(request.user!, server.id);
      // The same answer a wrong id gets: hidden means hidden.
      if (access === 'none') return reply.code(404).send({ error: 'unknown-server' });

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
          // Per-server: an exception that makes someone operator of this
          // server also earns them its details.
          detail: access !== 'member' ? row.detail : null,
        }));

      return reply.send({ server: { ...(await describe(server)), yourAccess: access }, history });
    },
  );
}
