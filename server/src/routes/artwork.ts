import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ARTWORK_KINDS, contentTypeFor, type ArtworkKind } from '../artwork.js';

export function registerArtworkRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, artwork, guard } = ctx;

  /**
   * Behind the same auth as everything else: the artwork reveals which games
   * you run, and there is no reason to expose that to the internet at large.
   */
  app.get<{ Params: { id: string; kind: string } }>(
    '/artwork/:id/:kind',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      // Routed through the server whitelist like everything else, so the path
      // can never be steered by the client.
      const server = registry.get(request.params.id);
      const kind = request.params.kind as ArtworkKind;
      if (!server || !ARTWORK_KINDS.includes(kind)) {
        return reply.code(404).send({ error: 'not-found' });
      }

      const path = await artwork.resolve(server.id, kind);
      if (!path) return reply.code(404).send({ error: 'no-artwork' });

      return reply
        .type(contentTypeFor(path))
        // Immutable in practice: the file only changes if it is deleted and
        // re-fetched, and the id is stable.
        .header('cache-control', 'private, max-age=86400')
        .send(createReadStream(path));
    },
  );
}
