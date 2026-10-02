import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
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

  /*
   * Renames what people see. The container, the id, the artwork and the URLs
   * all stay: a display name is presentation, and tying it to identity is how
   * "SoulmaskFor-Linux" ends up carved on a card forever. Only servers the
   * portal deployed can be renamed here -- the config file is the operator's
   * own text, and this portal does not edit it.
   */
  app.put<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/servers/:id/name',
    { preHandler: guard.requireServerOperator },
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const name = String(request.body?.name ?? '')
        .replace(/[\r\n]/g, ' ')
        .trim();
      if (name.length < 2 || name.length > 48) {
        return reply
          .code(400)
          .send({ error: 'bad-name', message: 'Give it a name of 2 to 48 characters.' });
      }

      const managed = ctx.db.listManagedServers().find((m) => m.id === server.id);
      if (!managed) {
        return reply.code(409).send({
          error: 'config-managed',
          message: 'This server comes from config/servers.json — rename it there.',
        });
      }

      const previous = server.displayName;
      ctx.db.updateManagedServer(server.id, {
        ...(managed.definition as Record<string, unknown>),
        displayName: name,
      });
      registry.reload();

      ctx.db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'server-renamed',
        result: 'success',
        detail: `"${previous}" is now "${name}"`,
        ...originOf(request),
      });
      return reply.send({ displayName: name });
    },
  );

  /*
   * Really deletes a server: the container is stopped and removed, the portal
   * forgets it. Owner only -- this is the one server action that cannot be
   * walked back with a start button. What is deliberately NOT touched: the
   * game's data directory and any backups. Worlds do not die by button; the
   * disk is cleaned by hand, by someone looking at what they are deleting.
   */
  app.delete<{ Params: { id: string } }>(
    '/api/servers/:id',
    { preHandler: guard.requireOwner },
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const managed = ctx.db.listManagedServers().some((m) => m.id === server.id);
      if (!managed) {
        return reply.code(409).send({
          error: 'config-managed',
          message:
            'This server comes from config/servers.json. Remove it there; the portal will not touch servers it did not deploy.',
        });
      }

      try {
        const container = docker.docker.getContainer(server.container);
        await container.stop({ t: 20 }).catch((err) => {
          if ((err as { statusCode?: number }).statusCode !== 304) throw err;
        });
        await container.remove({ force: true });
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) {
          // A container that will not die stays listed, so nothing is half-gone.
          return reply
            .code(502)
            .send({ error: 'remove-failed', message: (err as Error).message });
        }
      }

      ctx.db.removeManagedServer(server.id);
      ctx.db.removeSchedulesFor(server.id);
      ctx.db.clearServerRoleOverrides(server.id);
      registry.reload();
      docker.invalidate(server);

      ctx.db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'server-removed',
        result: 'success',
        detail: `Deleted ${server.displayName}: container stopped and removed; game data and backups left on disk`,
        ...originOf(request),
      });
      return reply.send({ ok: true });
    },
  );
}
