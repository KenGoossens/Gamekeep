import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { GsltError } from '../steam/gslt.js';

/**
 * The Steam Web API key that lets the portal mint game server login tokens
 * for match servers. Owner-only: the key acts as the owner's Steam account.
 */
export function registerGsltRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, guard, gslt } = ctx;
  const owner = { preHandler: guard.requireOwner };

  app.get('/api/integrations/steam', owner, async (_request, reply) => {
    // The key itself is never in this answer, only whether it still works.
    return reply.send(await gslt.status());
  });

  app.put<{ Body: { apiKey?: string } }>(
    '/api/integrations/steam',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const apiKey = (request.body?.apiKey ?? '').trim();
      if (!/^[0-9A-Fa-f]{32}$/.test(apiKey)) {
        return reply.code(400).send({
          error: 'bad-key',
          message:
            'That does not look like a Steam Web API key (32 hex characters, from steamcommunity.com/dev/apikey).',
        });
      }

      try {
        const status = await gslt.setApiKey(apiKey);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'integration-changed',
          result: 'success',
          detail: `Steam game server tokens connected (${status.tokenCount} existing token(s))`,
          ...originOf(request),
        });
        return reply.send(status);
      } catch (err) {
        // Proven before stored, so a mistyped key is found now, not on match night.
        return reply.code(err instanceof GsltError ? 400 : 502).send({
          error: 'steam-refused',
          message: err instanceof Error ? err.message : 'Steam could not be reached.',
        });
      }
    },
  );

  app.delete('/api/integrations/steam', owner, async (request, reply) => {
    const user = request.user!;
    gslt.clear();
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: null,
      action: 'integration-changed',
      result: 'success',
      detail: 'Steam game server tokens disconnected',
      ...originOf(request),
    });
    return reply.send({ configured: false, ok: null, tokenCount: null, banned: null, error: null });
  });
}
