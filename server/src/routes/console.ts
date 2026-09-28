import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';

/**
 * Sending a command to the game's own console.
 *
 * Most dedicated servers read admin commands from stdin -- save-all, say,
 * kick -- and the live log already shows their answers. This is the other
 * half: a one-shot attach to the container's stdin that writes one line and
 * lets go. The output arrives through the log stream like everything else,
 * so there is no second channel to keep alive.
 *
 * Operator level, one line at a time, and every line lands in the audit log.
 * A console command is arbitrary input to the game -- the game decides what
 * it means, and whoever reads the audit trail decides whether it was wise.
 */

const MAX_COMMAND = 500;

export function registerConsoleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, db, guard } = ctx;

  app.post<{ Params: { id: string }; Body: { command?: string } }>(
    '/api/servers/:id/console',
    { preHandler: guard.requireServerOperator },
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const command = String(request.body?.command ?? '').trim();
      if (!command) {
        return reply.code(400).send({ error: 'empty', message: 'Type a command first.' });
      }
      if (command.length > MAX_COMMAND) {
        return reply
          .code(400)
          .send({ error: 'too-long', message: `Keep it under ${MAX_COMMAND} characters.` });
      }
      // One line means one command. A pasted newline would smuggle a second
      // one past both the confirmation and the audit trail.
      if (/[\r\n\0]/.test(command)) {
        return reply
          .code(400)
          .send({ error: 'multiline', message: 'One command at a time — no line breaks.' });
      }

      const container = docker.docker.getContainer(server.container);
      let info: Awaited<ReturnType<typeof container.inspect>>;
      try {
        info = await container.inspect();
      } catch {
        return reply.code(404).send({ error: 'no-container' });
      }

      if (!info.State?.Running) {
        return reply
          .code(409)
          .send({ error: 'not-running', message: 'The server is not running.' });
      }
      /*
       * Both checks are about the container, not the game. Without OpenStdin
       * (docker run -i) there is no stdin to write to at all. With StdinOnce
       * set, Docker closes the container's stdin when our attach detaches --
       * and a game that reads EOF as "shut down" would be stopped by the very
       * act of talking to it. Both are stated plainly instead of failing
       * somewhere ambiguous.
       */
      if (!info.Config?.OpenStdin) {
        return reply.code(409).send({
          error: 'no-stdin',
          message:
            'This container was created without an interactive console (no -i), so its game cannot be typed at. Recreate it in Unraid with "Interactive" enabled to use this.',
        });
      }
      if (info.Config?.StdinOnce) {
        return reply.code(409).send({
          error: 'stdin-once',
          message:
            'This container closes its stdin after one attach (StdinOnce), so sending a command could shut the game down. Refusing.',
        });
      }

      try {
        const stream = await container.attach({
          stream: true,
          stdin: true,
          stdout: false,
          stderr: false,
          hijack: true,
        });
        await new Promise<void>((resolve, reject) => {
          stream.write(`${command}\n`, (err) => (err ? reject(err) : resolve()));
        });
        // Half a beat for the socket to flush, then detach. With StdinOnce
        // refused above, detaching leaves the container's stdin open.
        await new Promise((r) => setTimeout(r, 150));
        stream.end();
      } catch (err) {
        return reply
          .code(502)
          .send({ error: 'attach-failed', message: (err as Error).message });
      }

      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'console-command',
        result: 'success',
        detail: command,
        ...originOf(request),
      });

      return reply.send({ sent: true });
    },
  );
}
