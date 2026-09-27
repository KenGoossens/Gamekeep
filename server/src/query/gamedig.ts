import { GameDig } from 'gamedig';
import type { ServerConfig } from '../config.js';

export interface PlayerInfo {
  online: number;
  max: number | null;
  /** Player names when the game reports them; many servers report none. */
  names: string[];
  serverName: string | null;
  map: string | null;
}

const QUERY_TTL_MS = 10_000;
/** Failures are cached briefly too, so a down server isn't re-queried per poll. */
const FAILURE_TTL_MS = 5_000;
const SOCKET_TIMEOUT_MS = 3_000;

export function createGameQuery() {
  const cache = new Map<string, { at: number; ttl: number; value: PlayerInfo | null }>();
  const inFlight = new Map<string, Promise<PlayerInfo | null>>();

  async function run(query: NonNullable<ServerConfig['query']>): Promise<PlayerInfo | null> {
    const state = await GameDig.query({
      type: query.type,
      host: query.host,
      port: query.port,
      socketTimeout: SOCKET_TIMEOUT_MS,
      attemptTimeout: SOCKET_TIMEOUT_MS * 2,
      maxRetries: 1,
    });

    const names = state.players.map((p) => p.name).filter((n) => n.length > 0);

    return {
      // Some protocols report a count without names, others list names without
      // a count, so take whichever is larger.
      online: Math.max(state.numplayers || 0, state.players.length),
      max: state.maxplayers > 0 ? state.maxplayers : null,
      names,
      serverName: state.name || null,
      map: state.map || null,
    };
  }

  /**
   * Never rejects. A game server that is down fails this query -- which is
   * exactly the moment someone wants to press Restart -- so a failure must
   * degrade to "unknown" rather than break the status endpoint.
   */
  async function getPlayers(server: ServerConfig): Promise<PlayerInfo | null> {
    if (!server.query) return null;

    const key = server.id;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = run(server.query)
      .then((value) => {
        cache.set(key, { at: Date.now(), ttl: QUERY_TTL_MS, value });
        return value;
      })
      .catch(() => {
        cache.set(key, { at: Date.now(), ttl: FAILURE_TTL_MS, value: null });
        return null;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  /**
   * Non-blocking read, for the dashboard. Returns whatever is cached right now
   * and refreshes in the background if stale.
   *
   * A game server that is down takes about six seconds to fail a query -- and a
   * server being down is exactly when everyone opens the portal. Awaiting that
   * on every poll makes an outage look like the portal itself is broken, so the
   * status endpoint never waits for a game query; the count simply fills in on
   * the next poll.
   */
  function getPlayersCached(server: ServerConfig): PlayerInfo | null {
    if (!server.query) return null;

    const cached = cache.get(server.id);
    const isFresh = cached && Date.now() - cached.at < cached.ttl;
    if (!isFresh) void getPlayers(server).catch(() => undefined);

    return cached ? cached.value : null;
  }

  function invalidate(serverId: string) {
    cache.delete(serverId);
  }

  return { getPlayers, getPlayersCached, invalidate };
}

export type GameQuery = ReturnType<typeof createGameQuery>;
