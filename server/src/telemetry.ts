import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Db } from './db.js';
import type { Env } from './config.js';
import { games as gamedigGames } from 'gamedig';
import { gameByQueryType } from './games.js';
import type { ServerRegistry } from './registry.js';
import type { DockerClient } from './docker/client.js';
import type { GameQuery } from './query/gamedig.js';

/**
 * Anonymous usage statistics — OFF by default, opt-in only, and radically
 * transparent: the exact payload below is what the owner sees behind the
 * "view exactly what is sent" button, what the wiki documents line by line,
 * and what feeds the public stats page. Nothing here can identify a person,
 * a machine or a server: no names, no addresses, no ports, no logs.
 *
 * One ping per day, at most. A build without a TELEMETRY_ENDPOINT stays
 * silent even when opted in — and the UI says so instead of pretending.
 */

export interface TelemetryPayload {
  /** A random id, generated once, meaning nothing outside these pings. Its
   * only job is making "how many installs" countable without counting one
   * install twice. */
  install: string;
  version: string;
  /** 'unraid' when the Unraid template mount is present, else the OS. */
  platform: string;
  /** How many servers this portal watches (match servers excluded). */
  servers: number;
  /** How many of them are up right now. */
  serversRunning: number;
  /**
   * Player counts as plain numbers: how many are playing at this moment, and
   * the busiest moment of the last day. Counts only — player names never
   * leave the portal, and the community page is more fun with a pulse.
   */
  players: number;
  playersPeak24h: number;
  /** Games GameKeepr's own registry recognises, by NAME with a count each —
   * never your server names, which are the owner's. */
  games: Record<string, number>;
  /**
   * Games running here that the registry does NOT know yet, named from
   * GameDig's public catalogue of 358 games (so still a game's name, never
   * yours); 'Unknown' when even that cannot say. This is the wish list: it
   * tells the project which games to support next.
   */
  gamesWanted: Record<string, number>;
  /** Which big features see any use at all — booleans, nothing finer. */
  features: {
    tournaments: boolean;
    schedules: boolean;
    validationRuns: boolean;
    backups: boolean;
    mods: boolean;
    notifications: boolean;
    router: boolean;
  };
  sentAt: string;
}

const ENABLED_KEY = 'telemetry.enabled';
const INSTALL_KEY = 'telemetry.install';
const LAST_SENT_KEY = 'telemetry.lastSentAt';
const LAST_STATUS_KEY = 'telemetry.lastStatus';
const INVITED_KEY = 'telemetry.invited';

/** Checked hourly; sent when a day has passed. */
/**
 * A game's public name for a query type the registry does not carry, taken
 * from GameDig's own catalogue — which is also the safety rail: a type is
 * only ever reported when it appears there, so a hand-written
 * `"type": "my-private-thing"` in servers.json can never leak out as text.
 */
function gamedigName(type: string | undefined): string {
  if (!type) return 'Unknown';
  const entry = (gamedigGames as Record<string, { name?: string } | undefined>)[type];
  return typeof entry?.name === 'string' ? entry.name : 'Unknown';
}

const CHECK_MS = 60 * 60_000;
const SEND_EVERY_MS = 24 * 3_600_000 - 2 * 60_000;

export function createTelemetry(deps: {
  db: Db;
  registry: ServerRegistry;
  docker: DockerClient;
  gameQuery: GameQuery;
  env: Env;
  version: string;
  log: (message: string) => void;
}) {
  const { db, registry, docker, gameQuery, env, version, log } = deps;

  /**
   * Which kind of host this is, by two independent signs — because one was
   * not enough: a real Unraid box reported itself as plain 'linux' for days
   * because its template mount sat at a different path than the variable
   * named. Unraid's own Docker UI stamps HOST_OS into every container it
   * creates, which is the sign that does not depend on anyone's mount.
   */
  function detectPlatform(): string {
    if ((process.env.HOST_OS ?? '').toLowerCase().includes('unraid')) return 'unraid';
    if (existsSync(env.UNRAID_TEMPLATE_DIR)) return 'unraid';
    return process.platform;
  }

  const enabled = (): boolean => db.getSetting(ENABLED_KEY) === 'true';

  function setEnabled(value: boolean) {
    db.setSetting(ENABLED_KEY, value ? 'true' : 'false');
    // Deciding is being asked: whichever way it went, the invitation is spent.
    db.setSetting(INVITED_KEY, String(Date.now()));
  }

  /**
   * Whether this install has ever been ASKED. New installs answer the
   * question at setup, so only portals that upgraded into this feature are
   * pending — they would otherwise never learn the invitation exists.
   * Dismissing counts as answering: nobody is asked twice.
   */
  const invitePending = (): boolean => db.getSetting(INVITED_KEY) === null;

  function markInvited() {
    db.setSetting(INVITED_KEY, String(Date.now()));
  }

  function installId(): string {
    let id = db.getSetting(INSTALL_KEY);
    if (!id) {
      id = randomUUID();
      db.setSetting(INSTALL_KEY, id);
    }
    return id;
  }

  /** A guarded count: a table that cannot be counted counts as zero. */
  function countOf(table: 'tournaments' | 'schedules' | 'backups' | 'installed_mods'): number {
    try {
      const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  /**
   * The busiest minute of the last day, summed across servers. Read from the
   * metrics the portal already keeps for its own charts — counts only, never
   * who was playing. Bucketed per minute because each server is sampled on
   * its own clock and raw timestamps would never line up.
   */
  function peakPlayers24h(): number {
    try {
      const row = db.raw
        .prepare(
          `SELECT COALESCE(MAX(total), 0) AS peak FROM (
             SELECT SUM(COALESCE(players, 0)) AS total
             FROM metrics WHERE ts > ? GROUP BY ts / 60000
           )`,
        )
        .get(Date.now() - 24 * 3_600_000) as { peak: number } | undefined;
      return Math.max(0, Math.round(row?.peak ?? 0));
    } catch {
      return 0;
    }
  }

  /** The whole truth, buildable at any time — this IS the preview. */
  async function payload(): Promise<TelemetryPayload> {
    const servers = registry.list().filter((s) => !s.transient);
    const games: Record<string, number> = {};
    const gamesWanted: Record<string, number> = {};
    let serversRunning = 0;
    let players = 0;
    for (const server of servers) {
      const known = gameByQueryType(server.query?.type);
      if (known) {
        games[known.label] = (games[known.label] ?? 0) + 1;
      } else {
        const wanted = gamedigName(server.query?.type);
        gamesWanted[wanted] = (gamesWanted[wanted] ?? 0) + 1;
      }
      const status = await docker.getStatus(server).catch(() => null);
      if (status?.running) serversRunning++;
      players += gameQuery.getPlayersCached(server)?.online ?? 0;
    }
    let validationRuns = false;
    try {
      validationRuns = JSON.parse(db.getSetting('validation.history') ?? '[]').length > 0;
    } catch {
      // Unreadable history simply counts as unused.
    }
    return {
      install: installId(),
      version,
      platform: detectPlatform(),
      servers: servers.length,
      serversRunning,
      players,
      playersPeak24h: peakPlayers24h(),
      games,
      gamesWanted,
      features: {
        tournaments: countOf('tournaments') > 0,
        schedules: countOf('schedules') > 0,
        validationRuns,
        backups: countOf('backups') > 0,
        mods: countOf('installed_mods') > 0,
        notifications: Boolean(db.getSetting('notifications')),
        router: Boolean(db.getSetting('router')),
      },
      sentAt: new Date().toISOString(),
    };
  }

  async function send(): Promise<{ ok: boolean; detail: string }> {
    if (!env.TELEMETRY_ENDPOINT) {
      return { ok: false, detail: 'No statistics endpoint is configured in this build.' };
    }
    try {
      const response = await fetch(env.TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `GameKeepr/${version}` },
        body: JSON.stringify(await payload()),
        signal: AbortSignal.timeout(10_000),
      });
      const detail = response.ok ? 'ok' : `The endpoint answered ${response.status}.`;
      if (response.ok) db.setSetting(LAST_SENT_KEY, String(Date.now()));
      db.setSetting(LAST_STATUS_KEY, detail);
      return { ok: response.ok, detail };
    } catch (err) {
      const detail = `Could not reach the endpoint: ${(err as Error).message}`;
      db.setSetting(LAST_STATUS_KEY, detail);
      return { ok: false, detail };
    }
  }

  async function state() {
    const lastSentAt = Number(db.getSetting(LAST_SENT_KEY)) || null;
    return {
      enabled: enabled(),
      invitePending: invitePending(),
      endpointConfigured: Boolean(env.TELEMETRY_ENDPOINT),
      /** Where the shared numbers are publicly visible — part of the deal. */
      statsUrl: env.TELEMETRY_ENDPOINT ? env.TELEMETRY_ENDPOINT.replace(/\/ping$/, '/stats') : null,
      lastSentAt,
      lastStatus: db.getSetting(LAST_STATUS_KEY),
      /** The literal payload the next ping would carry — the whole point. */
      payload: await payload(),
    };
  }

  function startLoop() {
    const tick = async () => {
      if (!enabled() || !env.TELEMETRY_ENDPOINT) return;
      const last = Number(db.getSetting(LAST_SENT_KEY)) || 0;
      if (Date.now() - last < SEND_EVERY_MS) return;
      const result = await send();
      if (!result.ok) log(`telemetry ping failed: ${result.detail}`);
    };
    setTimeout(() => void tick(), 90_000).unref();
    setInterval(() => void tick(), CHECK_MS).unref();
  }

  return { state, setEnabled, send, payload, startLoop, invitePending, markInvited };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
