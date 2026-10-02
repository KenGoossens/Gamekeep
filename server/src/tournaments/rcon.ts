import { Socket } from 'node:net';

/**
 * A minimal Source RCON client.
 *
 * Just enough protocol to tell a CS2 server to load its match config: auth,
 * one command at a time, close. Packets are [int32 size][int32 id][int32
 * type][body\0][\0]; auth is type 3, a command type 2, and a failed auth
 * answers with id -1. No multi-packet reassembly -- the commands sent here
 * get one-line answers, and anything longer is truncated harmlessly.
 */

export class RconError extends Error {}

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

export interface RconSession {
  exec(command: string): Promise<string>;
  close(): void;
}

export function rconConnect(
  host: string,
  port: number,
  password: string,
  timeoutMs = 10_000,
): Promise<RconSession> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setNoDelay(true);
    socket.setTimeout(timeoutMs);

    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const waiting = new Map<number, (body: string) => void>();
    let authResolve: ((ok: boolean) => void) | null = null;
    let settled = false;

    const fail = (err: Error) => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(err);
      }
      for (const resolveBody of waiting.values()) resolveBody('');
      waiting.clear();
    };

    socket.on('timeout', () => fail(new RconError(`rcon ${host}:${port} timed out`)));
    socket.on('error', (err) => fail(new RconError(`rcon ${host}:${port}: ${err.message}`)));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 2 + size).toString('utf8');
        buffer = buffer.subarray(4 + size);

        // Auth answers twice (an empty response, then the auth response).
        // Only the type-2 answer carries the verdict: id -1 means refused.
        if (authResolve && type === 2) {
          const resolveAuth = authResolve;
          authResolve = null;
          resolveAuth(id !== -1);
          continue;
        }
        const resolveBody = waiting.get(id);
        if (resolveBody) {
          waiting.delete(id);
          resolveBody(body);
        }
      }
    });

    socket.connect(port, host, () => {
      authResolve = (ok) => {
        if (!ok) return fail(new RconError(`rcon ${host}:${port} refused the password`));
        settled = true;
        resolve({
          exec(command: string): Promise<string> {
            return new Promise((resolveExec, rejectExec) => {
              const id = nextId++;
              const timer = setTimeout(() => {
                waiting.delete(id);
                rejectExec(new RconError(`rcon command timed out: ${command}`));
              }, timeoutMs);
              waiting.set(id, (body) => {
                clearTimeout(timer);
                resolveExec(body);
              });
              socket.write(packet(id, SERVERDATA_EXECCOMMAND, command));
            });
          },
          close() {
            socket.destroy();
          },
        });
      };
      socket.write(packet(0, SERVERDATA_AUTH, password));
    });
  });
}
