import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { ServerConfig } from '../config.js';
import { gameByQueryType, type GameProfile, type WorkshopLayout } from '../games.js';
import { ModSourceError } from '../mods/sources.js';
import {
  judgeWorkshopItem,
  lookupWorkshopItem,
  lookupWorkshopItems,
  parseWorkshopReference,
  type WorkshopItem,
} from '../mods/workshop.js';
import { notifyServer } from '../notify.js';

/**
 * Steam Workshop mods, for the games that fetch their own.
 *
 * Separate from the mod routes because the model is separate: nothing is
 * downloaded, scanned or written into the game's files here. A Workshop id is
 * added to a list in the server's own config and the server collects the mod
 * itself on the next start. The consequences worth keeping in mind are that
 * every change needs a restart, and that the portal cannot vouch for the
 * mod's contents -- it never sees them.
 *
 * Operator level, and only while stopped, which are the same rules the files
 * and settings tabs follow. This edits a config file; doing that underneath a
 * running server produces a state nobody can reason about.
 */
export function registerWorkshopRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, workshop, db, notify } = ctx;
  const operator = { preHandler: guardOperator(ctx) };

  interface Context {
    server: ServerConfig;
    game: GameProfile;
    layout: WorkshopLayout;
  }

  function context(id: string): Context | { error: { code: number; body: unknown } } {
    const server = registry.get(id);
    if (!server) return { error: { code: 404, body: { error: 'unknown-server' } } };

    const game = gameByQueryType(server.query?.type);
    if (!game?.workshop) {
      return {
        error: {
          code: 400,
          body: {
            error: 'not-workshop-game',
            message: game
              ? `${game.label} does not take mods from the Steam Workshop.`
              : 'This server has no game type set, so Gamekeep cannot tell where its mods come from.',
          },
        },
      };
    }
    return { server, game, layout: game.workshop };
  }

  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof ModSourceError) {
      const code =
        err.code === 'not-found'
          ? 404
          : err.code === 'bad-reference'
            ? 400
            : err.code === 'config-not-found'
              ? 409
              : 502;
      return reply.code(code).send({ error: err.code, message: err.message });
    }
    return reply
      .code(500)
      .send({ error: 'workshop-failed', message: (err as Error).message });
  }

  /**
   * Refused while the server is up.
   *
   * The same guarantee the settings and files tabs make, and enforced here
   * rather than only in the UI: a config rewritten under a running server is
   * either ignored until it restarts or, worse, half-read.
   */
  async function refuseWhileRunning(server: ServerConfig, reply: FastifyReply): Promise<boolean> {
    const status = await docker.getStatus(server);
    if (!status.running) return false;
    reply.code(409).send({
      error: 'server-running',
      message: 'Stop the server before changing its mod list.',
    });
    return true;
  }

  /** The declared list, with whatever Steam still knows about each entry. */
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/workshop',
    operator,
    async (request, reply) => {
      const found = context(request.params.id);
      if ('error' in found) return reply.code(found.error.code).send(found.error.body);

      try {
        const declared = await workshop.read(found.server, found.layout);
        const status = await docker.getStatus(found.server);

        // One batch for the lot. Steam omits ids it does not know, so what is
        // missing from the answer is reported as such rather than silently
        // dropped -- an item removed from the Workshop is exactly the case an
        // operator needs to see.
        let items: WorkshopItem[] = [];
        let lookupError: string | null = null;
        try {
          items = await lookupWorkshopItems(declared.items);
        } catch (err) {
          lookupError = (err as Error).message;
        }
        const known = new Set(items.map((i) => i.id));

        return reply.send({
          file: declared.file,
          running: status.running,
          note: found.layout.note,
          usesModIds: Boolean(found.layout.modIdsKey),
          modIds: declared.modIds,
          items: items.map((item) => ({
            ...item,
            verdict: judgeWorkshopItem(item, found.game),
          })),
          // Declared, but Steam has nothing for them.
          unknown: lookupError ? [] : declared.items.filter((id) => !known.has(id)),
          lookupError,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  /** Looks a mod up without changing anything, so the operator can decide. */
  app.get<{ Params: { id: string }; Querystring: { ref?: string } }>(
    '/api/servers/:id/workshop/lookup',
    operator,
    async (request, reply) => {
      const found = context(request.params.id);
      if ('error' in found) return reply.code(found.error.code).send(found.error.body);

      try {
        const item = await lookupWorkshopItem(request.query.ref ?? '');
        const declared = await workshop.read(found.server, found.layout);
        return reply.send({
          item,
          verdict: judgeWorkshopItem(item, found.game),
          alreadyDeclared: declared.items.includes(item.id),
          usesModIds: Boolean(found.layout.modIdsKey),
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reference?: string } }>(
    '/api/servers/:id/workshop',
    operator,
    async (request, reply) => {
      const found = context(request.params.id);
      if ('error' in found) return reply.code(found.error.code).send(found.error.body);
      if (await refuseWhileRunning(found.server, reply)) return reply;

      const user = request.user!;
      try {
        const item = await lookupWorkshopItem(request.body?.reference ?? '');
        const verdict = judgeWorkshopItem(item, found.game);
        if (!verdict.ok) {
          db.audit({
            userId: user.id,
            username: user.username,
            serverId: found.server.id,
            action: 'mod-install',
            result: 'denied',
            detail: `${item.title} (${item.id}): ${verdict.reasons[0]}`,
          });
          return reply
            .code(422)
            .send({ error: 'incompatible', message: verdict.reasons[0], verdict });
        }

        const declared = await workshop.read(found.server, found.layout);
        if (declared.items.includes(item.id)) {
          return reply
            .code(409)
            .send({ error: 'already-declared', message: `${item.title} is already on the list.` });
        }

        /*
         * Project Zomboid needs the publisher's own mod name as well as the
         * Workshop number, and a mod listed in only one of the two does
         * nothing at all. Adding both together is the whole reason this is a
         * button rather than an instruction to edit the file by hand.
         */
        const modIds = [...declared.modIds];
        for (const id of item.declaredModIds) if (!modIds.includes(id)) modIds.push(id);

        await workshop.write(found.server, found.layout, {
          items: [...declared.items, item.id],
          modIds,
        });

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: found.server.id,
          action: 'mod-install',
          result: 'success',
          detail: `${item.title} (${item.id})`,
        });
        notify.send({
          kind: 'mod-installed',
          server: notifyServer(found.server),
          actor: { username: user.username, role: user.role },
          detail: `${item.title} — from the Steam Workshop, active after the next start`,
        });

        return reply.send({
          item,
          verdict,
          // Said plainly: nothing has been downloaded yet, and the operator
          // who does not restart will wonder why nothing changed.
          message: found.layout.modIdsKey && item.declaredModIds.length === 0
            ? `Added. Gamekeep could not find this mod's own id in its Workshop description, so check the ${found.layout.modIdsKey} line before starting.`
            : 'Added. It downloads on the next start.',
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/servers/:id/workshop/:itemId',
    operator,
    async (request, reply) => {
      const found = context(request.params.id);
      if ('error' in found) return reply.code(found.error.code).send(found.error.body);
      if (await refuseWhileRunning(found.server, reply)) return reply;

      const user = request.user!;
      try {
        const itemId = parseWorkshopReference(request.params.itemId);
        const declared = await workshop.read(found.server, found.layout);
        if (!declared.items.includes(itemId)) {
          return reply
            .code(404)
            .send({ error: 'not-declared', message: 'That mod is not on this server’s list.' });
        }

        /*
         * The config keeps one flat list of mod names with nothing saying
         * which Workshop item each came from, so the item is looked up again
         * to find out what to take out with it. If Steam no longer knows it,
         * the names are left alone: removing the wrong one would silently
         * disable a mod the operator still wants.
         */
        let modIds = [...declared.modIds];
        let orphaned = false;
        if (found.layout.modIdsKey) {
          const [item] = await lookupWorkshopItems([itemId]).catch(() => []);
          if (item && item.declaredModIds.length > 0) {
            modIds = modIds.filter((id) => !item.declaredModIds.includes(id));
          } else {
            orphaned = declared.modIds.length > 0;
          }
        }

        await workshop.write(found.server, found.layout, {
          items: declared.items.filter((id) => id !== itemId),
          modIds,
        });

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: found.server.id,
          action: 'mod-remove',
          result: 'success',
          detail: itemId,
        });

        return reply.send({
          removed: itemId,
          message: orphaned
            ? `Removed from ${found.layout.itemsKey}. Steam no longer knows this item, so its entry in ${found.layout.modIdsKey} was left alone rather than guessed at.`
            : 'Removed. It stops loading after the next start.',
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}

/** Kept out of the body above only so the guard is named where it is used. */
function guardOperator(ctx: AppContext) {
  return ctx.guard.requireOperator;
}
