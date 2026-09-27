import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * Actions everyone can see. Account changes are included on purpose: if
 * someone new can restart the servers, everyone should be able to see that
 * they were added. Sign-in records stay out of the member-visible feed.
 */
const PUBLIC_ACTIONS = new Set([
  'restart',
  'start',
  'stop',
  'pull-recreate',
  'user-created',
  'user-deleted',
  'user-promoted',
  'user-demoted',
  'user-disabled',
  'user-enabled',
  'server-deployed',
  'server-removed',
]);

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, registry, guard } = ctx;

  app.get<{ Querystring: { limit?: string } }>(
    '/api/audit',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const user = request.user!;
      const names = new Map(registry.list().map((s) => [s.id, s.displayName]));
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 500);

      // Operators and owners see the complete record, including sign-ins and
      // failures. Members see only what people did to the servers.
      const full = user.role !== 'member';
      const rows = db.recentAudit(full ? limit : limit * 4);
      const visible = full ? rows : rows.filter((r) => PUBLIC_ACTIONS.has(r.action));

      return reply.send({
        canSeeDetail: full,
        // Where a request came from is only shown to owners: it is personal
        // data about the other members, not operational information.
        canSeeOrigin: user.role === 'owner',
        entries: visible.slice(0, limit).map((row) => ({
          id: row.id,
          ts: row.ts,
          username: row.username,
          serverId: row.serverId,
          serverName: row.serverId ? (names.get(row.serverId) ?? row.serverId) : null,
          action: row.action,
          result: row.result,
          detail: full ? row.detail : null,
          ip: user.role === 'owner' ? row.ip : null,
          userAgent: user.role === 'owner' ? row.userAgent : null,
        })),
      });
    },
  );
}
