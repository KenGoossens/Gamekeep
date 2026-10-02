import type { ServerConfig, Env } from '../config.js';
import type { Db } from '../db.js';
import type { DockerClient } from '../docker/client.js';
import { decryptSecret } from '../secrets.js';
import { coveredBy, requiredForwards } from '../unifi.js';
import { buildProvider, type RouterProvider } from './provider.js';
// Registers the UniFi provider, so loading a stored connection never depends
// on which route file happened to be imported first.
import './unifi-provider.js';

/** Where the router connection lives in app_settings. */
export const ROUTER_SETTING_KEY = 'router';

export interface StoredRouter {
  provider: string;
  config: Record<string, string>;
}

/** Decrypts the stored connection, or null when no router is connected. */
export function loadRouter(
  db: Pick<Db, 'getSetting'>,
  env: Pick<Env, 'SESSION_SECRET'>,
): { stored: StoredRouter; provider: RouterProvider } | null {
  const raw = db.getSetting(ROUTER_SETTING_KEY);
  if (!raw) return null;
  const plain = decryptSecret(raw, env.SESSION_SECRET);
  if (!plain) return null;

  try {
    const stored = JSON.parse(plain) as StoredRouter;
    const provider = buildProvider(stored.provider, stored.config);
    return provider ? { stored, provider } : null;
  } catch {
    return null;
  }
}

/**
 * Opens a new server's game ports on the router, unasked.
 *
 * The deploy already decided the ports; clicking a second button to make them
 * reachable was just a step people forgot, and the server then looked healthy
 * while nobody could join. Only ever the ports the game is played over: a
 * sensitive port (RCON, a web console) is never opened by anything automatic,
 * exactly as it is never pre-selected in the Network tab. Best-effort by
 * design -- a failed forward must not fail a succeeded deploy, so the result
 * is messages for the deploy log, not an exception.
 */
export async function autoForward(
  deps: { db: Db; env: Env; docker: DockerClient },
  server: ServerConfig,
  actor: { userId: string | null; username: string },
): Promise<string[]> {
  const { db, env, docker } = deps;
  const current = loadRouter(db, env);
  if (!current) return [];
  const target = env.LAN_ADDRESS.trim();
  if (!target) {
    return ['Router connected but LAN_ADDRESS is not set, so no forwards were made.'];
  }

  try {
    const [needed, existing] = await Promise.all([
      requiredForwards(docker, server),
      current.provider.list(),
    ]);
    const toOpen = needed.filter((n) => !n.sensitive && !existing.some((r) => coveredBy(r, n, target)));
    const skipped = needed.filter((n) => n.sensitive);

    const messages: string[] = [];
    for (const need of toOpen) {
      await current.provider.create(target, need);
      messages.push(`Forwarded ${need.proto} ${need.port} to ${target} on the router`);
    }
    for (const skip of skipped) {
      messages.push(
        `Left ${skip.proto} ${skip.port} closed (${skip.reason ?? 'administrative'}) — open it from the Network tab if you really mean to.`,
      );
    }

    if (toOpen.length > 0) {
      db.audit({
        userId: actor.userId,
        username: actor.username,
        serverId: server.id,
        action: 'portforward-opened',
        result: 'success',
        detail: `Opened ${toOpen.map((n) => `${n.proto} ${n.port}`).join(', ')} to ${target} (automatic, on deploy)`,
      });
    }
    return messages;
  } catch (err) {
    db.audit({
      userId: actor.userId,
      username: actor.username,
      serverId: server.id,
      action: 'portforward-opened',
      result: 'failure',
      detail: `Automatic forwarding failed: ${(err as Error).message}`,
    });
    return [`Could not forward the ports automatically: ${(err as Error).message}`];
  }
}
