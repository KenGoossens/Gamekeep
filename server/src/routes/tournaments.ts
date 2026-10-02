import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * The two endpoints a match server talks to. No session, no cookie: the match
 * is identified by its event token, 24 random bytes minted at provision time
 * and retired with the server. Both endpoints answer over the shared docker
 * network; nothing here mutates anything beyond the one match the token names.
 */
export function registerTournamentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { tournaments, matches } = ctx;

  const TOKEN = /^[0-9a-f]{48}$/;

  app.get<{ Params: { token: string } }>(
    '/api/tournaments/match-config/:token',
    async (request, reply) => {
      const { token } = request.params;
      if (!TOKEN.test(token)) return reply.code(404).send({ error: 'unknown-match' });
      const match = tournaments.getMatchByEventToken(token);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });
      const config = matches.buildConfigFor(match);
      if (!config) return reply.code(404).send({ error: 'unknown-match' });
      return reply.send(config);
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/tournaments/match-event',
    async (request, reply) => {
      const token = String(request.headers['x-gamekeepr-token'] ?? '');
      if (!TOKEN.test(token)) return reply.code(404).send({ error: 'unknown-match' });
      const match = tournaments.getMatchByEventToken(token);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });

      const payload = request.body;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        matches.applyEvent(match, payload);
      }
      // MatchZy treats anything outside 2xx as a failed delivery and it does
      // not retry; an event we cannot use is still an event we received.
      return reply.send({ ok: true });
    },
  );
}
