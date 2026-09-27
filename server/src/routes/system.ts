import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * Owner-only, because the report names containers, file paths and the LAN
 * address -- a map of the host, which is more than an operator needs to do
 * their job. It returns no credential of any kind, only whether each one works
 * and where it is kept.
 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { refresh?: string } }>(
    '/api/system/health',
    { preHandler: ctx.guard.requireOwner },
    async (request, reply) => {
      const report = await ctx.health.report(request.query.refresh === '1');
      return reply.send(report);
    },
  );
}
