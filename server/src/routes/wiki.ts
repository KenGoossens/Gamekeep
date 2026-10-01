import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { readPage, visiblePages } from '../wiki/index.js';

/**
 * The manual, behind the same sign-in as the rest. Every signed-in user gets
 * a wiki; which pages it contains follows their global role, enforced here
 * and not just hidden in the UI. Unreachable pages answer 404 -- the manual
 * for capabilities someone does not have reads as not existing, consistent
 * with how hidden servers behave.
 */
export function registerWikiRoutes(app: FastifyInstance, ctx: AppContext) {
  const { guard } = ctx;

  app.get('/api/wiki', { preHandler: guard.requireActiveUser }, async (request, reply) => {
    const pages = visiblePages(request.user!.role);
    const sections: Array<{ section: string; pages: Array<{ id: string; title: string }> }> = [];
    for (const page of pages) {
      let bucket = sections.find((s) => s.section === page.section);
      if (!bucket) {
        bucket = { section: page.section, pages: [] };
        sections.push(bucket);
      }
      bucket.pages.push({ id: page.id, title: page.title });
    }
    return reply.send({ sections });
  });

  /**
   * The wiki's screenshots: static files shipped beside the pages. Gated at
   * sign-in level -- what a screenshot teaches, the page's role gates; the
   * pixels themselves hold nothing a signed-in member may not see.
   */
  const imagesDir = join(dirname(fileURLToPath(import.meta.url)), '../wiki/images');
  app.get<{ Params: { file: string } }>(
    '/api/wiki/images/:file',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const file = request.params.file;
      // A plain name, no separators: this route serves one directory, period.
      if (!/^[A-Za-z0-9_-]+\.png$/.test(file)) {
        return reply.code(404).send({ error: 'unknown-image' });
      }
      const path = join(imagesDir, file);
      try {
        await stat(path);
      } catch {
        return reply.code(404).send({ error: 'unknown-image' });
      }
      reply.header('content-type', 'image/png');
      reply.header('cache-control', 'private, max-age=86400');
      return reply.send(createReadStream(path));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/wiki/:id',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const page = await readPage(request.params.id, request.user!.role);
      if (!page) return reply.code(404).send({ error: 'unknown-page' });
      return reply.send({ id: page.meta.id, title: page.meta.title, markdown: page.markdown });
    },
  );
}
