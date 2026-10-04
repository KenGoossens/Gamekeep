import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { COMMON_SETTINGS, gameByQueryType, type SettingSpec } from '../games.js';
import { SettingsError } from '../settings.js';
import { GameSettingsError, JOIN_KEYS, type JoinKey } from '../gamesettings.js';
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
  // Member level, but per server: metrics and the world card are for anyone
  // who can see the server at all -- which an exception can take away.
  const anyone = { preHandler: guard.requireServerMember };
  const operator = { preHandler: guard.requireServerOperator };

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

  // ---- the game's own config file (the Settings Scan) -------------------

  /**
   * Where this game keeps its Game Settings and what the join keys say now.
   * Null scan = either the game has no described config file, or the file does
   * not exist yet (most games write it on first boot) — the response says
   * which, so the UI can speak plainly.
   */
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/gamesettings',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      try {
        const scan = await ctx.gameSettings.scan(server);
        const supported = gameByQueryType(server.query?.type)?.configFile !== undefined;
        return reply.send({ supported, scan });
      } catch (err) {
        if (err instanceof GameSettingsError) {
          return reply.code(502).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  /** One game-settings write at a time per server; a second PUT waits its turn. */
  const gameSettingsBusy = new Set<string>();

  /**
   * Changes the join keys in the game's own file, with the full choreography:
   * everything that can refuse runs BEFORE the stop (a server must never be
   * taken down for an edit that was going to fail), then stop, write with
   * backup, and start again in a finally — whatever happened in between. The
   * re-verification watch proves through the name-match that the game really
   * read what was written.
   */
  app.put<{ Params: { id: string }; Body: { values?: Partial<Record<string, string>> } }>(
    '/api/servers/:id/gamesettings',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      // A match server's lifecycle belongs to its tournament, same as every
      // other steering wheel it refuses.
      if (server.transient) return reply.code(403).send({ error: 'match-managed' });
      if (ctx.actions.activeJobFor(server.id)) {
        return reply.code(409).send({
          error: 'busy',
          message: 'A restart or stop is already running on this server; wait for it to finish.',
        });
      }
      if (gameSettingsBusy.has(server.id)) {
        return reply.code(409).send({ error: 'busy', message: 'Another game-settings save is already running.' });
      }

      const raw = request.body?.values;
      if (!raw || typeof raw !== 'object') return reply.code(400).send({ error: 'invalid-body' });
      const values: Partial<Record<JoinKey, string>> = {};
      for (const key of JOIN_KEYS) {
        if (typeof raw[key] === 'string') values[key] = raw[key];
      }
      if (Object.keys(values).length === 0) {
        return reply.send({ applied: [], watchId: null, message: 'Nothing changed.' });
      }

      gameSettingsBusy.add(server.id);
      try {
        // Every refusal happens here, with the server still running.
        const prepared = await ctx.gameSettings.prepare(server, values);

        const wasRunning = (await docker.getStatus(server)).running;
        let watchId: string | null = null;
        let commitError: unknown = null;
        try {
          if (wasRunning) {
            try {
              await docker.docker.getContainer(server.container).stop({ t: 30 });
            } catch (err) {
              if ((err as { statusCode?: number }).statusCode !== 304) throw err;
            }
            docker.invalidate(server);
          }
          await ctx.gameSettings.commit(server, prepared.file, prepared.text);
        } catch (err) {
          commitError = err;
        } finally {
          // The server comes back whatever happened to the write: a config
          // edit must never be the reason a server stays down.
          if (wasRunning) {
            try {
              await docker.docker.getContainer(server.container).start();
              docker.invalidate(server);
              if (!commitError) {
                // The re-verification is the proof: if the image regenerates
                // this file from env, the name comes back wrong and the watch
                // says so — in settings words, not deploy words.
                watchId = ctx.deployWatch.start(server, values.name?.trim() || null, 'settings').id;
              }
            } catch (err) {
              if ((err as { statusCode?: number }).statusCode !== 304) {
                commitError ??= err;
              }
            }
          }
        }
        if (commitError) throw commitError;

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'settings-changed',
          result: 'success',
          // Only the names, never the values: two of these are passwords.
          detail: `Game settings changed in ${prepared.file}: ${prepared.applied.join(', ')}${wasRunning ? ' (server restarted to apply)' : ''}`,
          ...originOf(request),
        });
        // The fresh view rides along so the client needs no second scan.
        const scan = await ctx.gameSettings.scan(server).catch(() => null);
        return reply.send({ applied: prepared.applied, file: prepared.file, watchId, scan });
      } catch (err) {
        if (err instanceof GameSettingsError) {
          const status = err.code === 'unsupported' ? 404 : err.code === 'not-found' ? 409 : 502;
          return reply.code(status).send({ error: err.code, message: err.message });
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
      } finally {
        gameSettingsBusy.delete(server.id);
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
