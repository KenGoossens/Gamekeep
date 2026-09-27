import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';

/**
 * Reading a game server's console output, live.
 *
 * Operator level, not member: a game server log carries player IP addresses,
 * join and leave times, chat in some games, and whatever credentials the
 * container prints at start-up. That is a different thing from "may press
 * restart", so it sits with files and settings rather than with the button
 * everyone gets.
 *
 * Streamed over Server-Sent Events rather than a WebSocket. It is one-way, it
 * survives the Cloudflare tunnel without extra handling, and the browser
 * reconnects by itself -- three properties a log tail wants and a socket would
 * have to be given.
 */

/** Enough to see what happened, bounded so one request cannot read a gigabyte. */
const DEFAULT_TAIL = 300;
const MAX_TAIL = 5000;
/**
 * Docker sends nothing at all on a quiet server, and an idle connection is
 * eventually dropped by anything sitting in between. A comment line every
 * twenty seconds keeps it open and costs two bytes.
 */
const HEARTBEAT_MS = 20_000;
/** A single log line is truncated past this; some servers print stack dumps. */
const MAX_LINE = 8192;

/** SSE needs each line prefixed and a blank line to terminate the event. */
function sseWrite(reply: FastifyReply, event: string, data: string): void {
  const payload = data
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  reply.raw.write(`event: ${event}\n${payload}\n\n`);
}

export function registerLogRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, db, guard } = ctx;
  const operator = { preHandler: guard.requireOperator };

  const tailOf = (raw: unknown): number =>
    Math.min(Math.max(Number(raw) || DEFAULT_TAIL, 1), MAX_TAIL);

  /** A snapshot, for the initial paint and for copying out. */
  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/api/servers/:id/logs',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      try {
        const buffer = (await docker.docker.getContainer(server.container).logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          tail: tailOf(request.query.tail),
        })) as unknown as Buffer;

        return reply.send({ text: demux(buffer) });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404) return reply.code(404).send({ error: 'no-container' });
        return reply.code(502).send({ error: 'logs-failed', message: (err as Error).message });
      }
    },
  );

  /** The live tail. */
  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    '/api/servers/:id/logs/stream',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      db.audit({
        userId: user.id,
        username: user.username,
        serverId: server.id,
        action: 'logs-read',
        result: 'success',
        detail: 'Opened the live log',
        ...originOf(request),
      });

      // Fastify stops managing this reply from here: the body is written to
      // the raw socket over minutes, which is not a response it can serialise.
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tells any proxy in the path not to sit on the bytes waiting for a
        // buffer to fill, which would defeat the whole point of a live tail.
        'x-accel-buffering': 'no',
      });

      let stream: NodeJS.ReadableStream | null = null;
      let closed = false;
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);

      /*
       * Every exit runs through here. A follow stream that is not destroyed
       * keeps a connection to the Docker socket open for as long as the
       * container lives, and a page refresh would leak one each time.
       */
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        (stream as unknown as { destroy?: () => void })?.destroy?.();
        reply.raw.end();
      };

      request.raw.on('close', close);
      request.raw.on('error', close);

      try {
        stream = (await docker.docker.getContainer(server.container).logs({
          stdout: true,
          stderr: true,
          timestamps: true,
          follow: true,
          tail: tailOf(request.query.tail),
        })) as unknown as NodeJS.ReadableStream;
      } catch (err) {
        sseWrite(reply, 'error', (err as Error).message);
        close();
        return reply;
      }

      // The container may have gone away between the check and now.
      if (closed) {
        (stream as unknown as { destroy?: () => void })?.destroy?.();
        return reply;
      }

      const out = new PassThrough();
      const errs = new PassThrough();
      docker.docker.modem.demuxStream(stream, out, errs);

      let pending = '';
      const emit = (chunk: Buffer, kind: 'out' | 'err') => {
        pending += chunk.toString('utf8');
        // Split on newlines so a partial line is never sent as an event; a
        // half-line would render as a line of its own and never be completed.
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length === 0) continue;
          sseWrite(reply, kind === 'err' ? 'stderr' : 'stdout', line.slice(0, MAX_LINE));
        }
      };

      out.on('data', (c: Buffer) => emit(c, 'out'));
      errs.on('data', (c: Buffer) => emit(c, 'err'));
      stream.on('end', () => {
        sseWrite(reply, 'ended', 'The container stopped producing output.');
        close();
      });
      stream.on('error', (err: Error) => {
        sseWrite(reply, 'error', err.message);
        close();
      });

      return reply;
    },
  );
}

/**
 * Docker frames each line with an eight-byte header saying which stream it
 * came from and how long it is -- unless the container was created with a TTY,
 * in which case the bytes are raw. Both shapes arrive here, so the header is
 * detected rather than assumed.
 */
function demux(buffer: Buffer): string {
  const parts: string[] = [];
  let at = 0;

  while (at + 8 <= buffer.length) {
    const type = buffer[at];
    // A frame header starts with 0, 1 or 2 followed by three zero bytes.
    const framed =
      (type === 0 || type === 1 || type === 2) &&
      buffer[at + 1] === 0 &&
      buffer[at + 2] === 0 &&
      buffer[at + 3] === 0;

    if (!framed) break;

    const length = buffer.readUInt32BE(at + 4);
    if (at + 8 + length > buffer.length) break;
    parts.push(buffer.toString('utf8', at + 8, at + 8 + length));
    at += 8 + length;
  }

  // Either it was never framed, or a trailing partial frame is left over.
  if (parts.length === 0) return buffer.toString('utf8');
  if (at < buffer.length) parts.push(buffer.toString('utf8', at));
  return parts.join('');
}
