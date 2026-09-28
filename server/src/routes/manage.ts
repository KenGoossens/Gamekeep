import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { COMMON_SETTINGS, gameByQueryType, type SettingSpec } from '../games.js';
import { SettingsError } from '../settings.js';
import { FileError } from '../files.js';
import { originOf } from '../auth/origin.js';
import { RETENTION_MS } from '../metrics.js';
import { readWorld } from '../world.js';

export function registerManageRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * The specs that apply to this server: the game's own plus the ones the
   * ich777 images share, filtered later by which variables actually exist.
   * The game's spec wins when both name the same key.
   */
  function specsFor(server: { query?: { type: string } }): SettingSpec[] {
    const own = gameByQueryType(server.query?.type)?.settings ?? [];
    const named = new Set(own.map((spec) => spec.key));
    return [...own, ...COMMON_SETTINGS.filter((spec) => !named.has(spec.key))];
  }

  const { registry, metrics, settings, files, db, docker, guard } = ctx;
  const anyone = { preHandler: guard.requireActiveUser };
  const operator = { preHandler: guard.requireOperator };

  /**
   * Refuses a write to a server that is running.
   *
   * Most game servers hold their configuration in memory and write it back on
   * shutdown, so an edit made while one runs is silently undone. This used to
   * live only in the browser, as a locked tab -- which meant the guarantee
   * held for anyone using the UI and for nobody else. Reading is left alone:
   * looking at a config costs nothing, and refusing to show it is why this was
   * invisible after a deploy in the first place.
   */
  async function refuseWhileRunning(
    server: ServerConfig,
    reply: FastifyReply,
  ): Promise<boolean> {
    const status = await docker.getStatus(server);
    if (!status.running) return false;
    reply.code(409).send({
      error: 'server-running',
      message: 'Stop the server first: it rewrites its own configuration on shutdown.',
    });
    return true;
  }

  // ---- performance ----------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/servers/:id/metrics',
    anyone,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const since = Math.min(Number(request.query.since) || RETENTION_MS, RETENTION_MS);
      return reply.send({
        current: await metrics.current(server),
        history: metrics.history(server.id, since),
        retentionMs: RETENTION_MS,
      });
    },
  );

  // ---- world -----------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/world',
    anyone,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      // Never fatal: a game we cannot read simply reports nothing.
      try {
        return reply.send({ world: await readWorld(server, files) });
      } catch {
        return reply.send({ world: null });
      }
    },
  );

  // ---- settings -------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/settings',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      try {
        // The specs ride along so the UI can explain the fields it knows;
        // ones whose variable the container lacks are simply never rendered.
        return reply.send({ settings: await settings.read(server), specs: specsFor(server) });
      } catch (err) {
        return reply.code(502).send({ error: 'read-failed', message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { changes?: Record<string, string> } }>(
    '/api/servers/:id/settings',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      if (await refuseWhileRunning(server, reply)) return reply;

      const changes = request.body?.changes;
      if (!changes || typeof changes !== 'object') {
        return reply.code(400).send({ error: 'invalid-body' });
      }

      try {
        const steps: string[] = [];
        const applied = await settings.apply(server, changes, (m) => steps.push(m), specsFor(server));

        if (applied.length === 0) {
          return reply.send({ applied: [], steps: [], message: 'Nothing changed.' });
        }

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'settings-changed',
          result: 'success',
          // Only the names, never the values: some of these are passwords.
          detail: `Changed ${applied.join(', ')}`,
          ...originOf(request),
        });
        return reply.send({ applied, steps });
      } catch (err) {
        // A value that fails its spec never got as far as touching the
        // container, so it is the operator's input to fix, not an incident.
        if (err instanceof SettingsError) {
          return reply.code(400).send({ error: 'invalid-value', message: err.message });
        }
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'settings-changed',
          result: 'failure',
          detail: (err as Error).message,
          ...originOf(request),
        });
        return reply.code(500).send({ error: 'apply-failed', message: (err as Error).message });
      }
    },
  );

  // ---- file editor ----------------------------------------------------
  const fileFailure = (err: unknown) =>
    err instanceof FileError
      ? { status: 400, body: { error: err.code, message: err.message } }
      : { status: 502, body: { error: 'file-failed', message: (err as Error).message } };

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/servers/:id/files',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      try {
        return reply.send(await files.list(server, request.query.path ?? ''));
      } catch (err) {
        const f = fileFailure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/servers/:id/file',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      if (!request.query.path) return reply.code(400).send({ error: 'path-required' });

      try {
        const content = await files.read(server, request.query.path);
        return reply.send({ path: request.query.path, content });
      } catch (err) {
        const f = fileFailure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { path?: string } }>(
    '/api/servers/:id/file/new',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      if (await refuseWhileRunning(server, reply)) return reply;
      if (typeof request.body?.path !== 'string') {
        return reply.code(400).send({ error: 'invalid-body' });
      }

      try {
        const result = await files.create(server, request.body.path);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'file-edited',
          result: 'success',
          detail: `Created ${result.path}`,
          ...originOf(request),
        });
        return reply.code(201).send(result);
      } catch (err) {
        const f = fileFailure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.post<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/servers/:id/file/upload',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      if (await refuseWhileRunning(server, reply)) return reply;

      const part = await request.file();
      if (!part) return reply.code(400).send({ error: 'no-file' });

      try {
        const buffer = await part.toBuffer();
        const result = await files.upload(
          server,
          request.query.path ?? '',
          part.filename,
          buffer,
        );
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'file-uploaded',
          result: 'success',
          detail: `Uploaded ${result.path} (${result.bytes} bytes)${result.replaced ? ', replaced an existing file' : ''}`,
          ...originOf(request),
        });
        return reply.send(result);
      } catch (err) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'file-uploaded',
          result: 'failure',
          detail: (err as Error).message,
          ...originOf(request),
        });
        const f = fileFailure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>(
    '/api/servers/:id/file',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      if (await refuseWhileRunning(server, reply)) return reply;

      const { path, content } = request.body ?? {};
      if (typeof path !== 'string' || typeof content !== 'string') {
        return reply.code(400).send({ error: 'invalid-body' });
      }

      try {
        const result = await files.write(server, path, content);
        if (result.unchanged) return reply.send(result);

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'file-edited',
          result: 'success',
          detail: `Edited ${result.path} (${result.bytes} bytes)${result.backup ? ', backup kept' : ''}`,
          ...originOf(request),
        });
        return reply.send(result);
      } catch (err) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'file-edited',
          result: 'failure',
          detail: `${path}: ${(err as Error).message}`,
          ...originOf(request),
        });
        const f = fileFailure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );
}
