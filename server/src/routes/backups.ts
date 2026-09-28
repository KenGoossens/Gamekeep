import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { BackupError } from '../backup.js';
import { gameByQueryType } from '../games.js';

/**
 * Backups are operator work, like everything else that changes what a server
 * runs. The asymmetry that matters is between making one and putting one back:
 * a backup of a running server is allowed -- games flush their saves all the
 * time, and a mostly-consistent copy beats none -- but a restore only happens
 * while the server is stopped, and never without a pre-restore backup of what
 * it is about to replace. A restore that goes wrong must itself be undoable.
 */
export function registerBackupRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, db, guard, backups } = ctx;
  const operator = { preHandler: guard.requireServerOperator };

  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof BackupError) {
      const code =
        err.code === 'not-configured' || err.code === 'bad-path'
          ? 400
          : err.code === 'busy'
            ? 409
            : err.code === 'file-missing'
              ? 404
              : 500;
      return reply.code(code).send({ error: err.code, message: err.message });
    }
    return reply.code(500).send({ error: 'backup-failed', message: (err as Error).message });
  }

  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/backups',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const status = await docker.getStatus(server);
      const paths = backups.configuredPaths(server.id);
      // Only searched for while nothing is configured: the find walks the
      // container's whole tree, which is not worth repeating on every open.
      const suggestions = paths.length === 0 ? await backups.suggest(server) : [];

      return reply.send({
        running: status.running,
        paths,
        suggestions,
        registryKnows: Boolean(gameByQueryType(server.query?.type)?.saves?.length),
        backups: db.listBackups(server.id),
      });
    },
  );

  app.put<{ Params: { id: string }; Body: { paths?: unknown } }>(
    '/api/servers/:id/backups/paths',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const raw = request.body?.paths;
      if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) {
        return reply.code(400).send({ error: 'bad-paths', message: 'Send a list of paths.' });
      }
      try {
        const paths = await backups.setPaths(server, raw);
        return reply.send({ paths });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/servers/:id/backups',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      try {
        const backup = await backups.make(server, { actor: user.username, kind: 'manual' });
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'backup-created',
          result: 'success',
          detail: backups.describe(backup),
          ...originOf(request),
        });
        return reply.code(201).send({ backup });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string; backupId: string } }>(
    '/api/servers/:id/backups/:backupId/restore',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const backup = db.getBackup(request.params.backupId);
      if (!backup || backup.serverId !== server.id) {
        return reply.code(404).send({ error: 'unknown-backup' });
      }

      // The hard rule. Restoring under a running game gives it a world that
      // changes beneath it, and the next autosave destroys the restore.
      const status = await docker.getStatus(server);
      if (status.running) {
        return reply
          .code(409)
          .send({ error: 'server-running', message: 'Stop the server before restoring.' });
      }

      try {
        /*
         * What is on disk right now is about to be overwritten, and might be
         * exactly what someone wants back tomorrow. The pre-restore copy uses
         * the same paths recorded in the backup being restored, so the two
         * are each other's mirror image.
         */
        await backups.setPaths(server, backup.paths);
        const safety = await backups.make(server, {
          actor: user.username,
          kind: 'pre-restore',
        });

        await backups.restore(server, backup);

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'backup-restored',
          result: 'success',
          detail: `Restored ${backup.file}; the replaced state is in ${safety.file}`,
          ...originOf(request),
        });
        return reply.send({ restored: backup.id, safety: safety.id });
      } catch (err) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'backup-restored',
          result: 'failure',
          detail: `${backup.file}: ${(err as Error).message}`,
          ...originOf(request),
        });
        return fail(reply, err);
      }
    },
  );

  /** The archive itself, for keeping a copy somewhere else entirely. */
  app.get<{ Params: { id: string; backupId: string } }>(
    '/api/servers/:id/backups/:backupId/download',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      const backup = db.getBackup(request.params.backupId);
      if (!backup || backup.serverId !== server.id) {
        return reply.code(404).send({ error: 'unknown-backup' });
      }
      reply.header('content-type', 'application/gzip');
      reply.header(
        'content-disposition',
        `attachment; filename="${server.id}-${backup.file}"`,
      );
      return reply.send(createReadStream(backups.localPath(backup)));
    },
  );

  app.delete<{ Params: { id: string; backupId: string } }>(
    '/api/servers/:id/backups/:backupId',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });
      const backup = db.getBackup(request.params.backupId);
      if (!backup || backup.serverId !== server.id) {
        return reply.code(404).send({ error: 'unknown-backup' });
      }

      await backups.remove(backup);
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'backup-removed',
        result: 'success',
        detail: backup.file,
        ...originOf(request),
      });
      return reply.send({ removed: backup.id });
    },
  );
}
