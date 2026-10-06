import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Db } from './db.js';
import type { Env } from './config.js';
import { gameByQueryType } from './games.js';
import type { ServerRegistry } from './registry.js';

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
  /** Recognised games by NAME with a count each; unrecognised ones are
   * counted as "Unknown" — never their actual names, which are the owner's. */
  games: Record<string, number>;
  /** Which big features see any use at all — booleans, nothing finer. */
  features: { tournaments: boolean; schedules: boolean; validationRuns: boolean };
  sentAt: string;
}

const ENABLED_KEY = 'telemetry.enabled';
const INSTALL_KEY = 'telemetry.install';
const LAST_SENT_KEY = 'telemetry.lastSentAt';
const LAST_STATUS_KEY = 'telemetry.lastStatus';

/** Checked hourly; sent when a day has passed. */
const CHECK_MS = 60 * 60_000;
const SEND_EVERY_MS = 24 * 3_600_000 - 2 * 60_000;

export function createTelemetry(deps: {
  db: Db;
  registry: ServerRegistry;
  env: Env;
  version: string;
  log: (message: string) => void;
}) {
  const { db, registry, env, version, log } = deps;

  const enabled = (): boolean => db.getSetting(ENABLED_KEY) === 'true';

  function setEnabled(value: boolean) {
    db.setSetting(ENABLED_KEY, value ? 'true' : 'false');
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
  function countOf(table: 'tournaments' | 'schedules'): number {
    try {
      const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  }

  /** The whole truth, buildable at any time — this IS the preview. */
  function payload(): TelemetryPayload {
    const servers = registry.list().filter((s) => !s.transient);
    const games: Record<string, number> = {};
    for (const server of servers) {
      const label = gameByQueryType(server.query?.type)?.label ?? 'Unknown';
      games[label] = (games[label] ?? 0) + 1;
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
      platform: existsSync(env.UNRAID_TEMPLATE_DIR) ? 'unraid' : process.platform,
      servers: servers.length,
      games,
      features: {
        tournaments: countOf('tournaments') > 0,
        schedules: countOf('schedules') > 0,
        validationRuns,
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
        body: JSON.stringify(payload()),
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

  function state() {
    const lastSentAt = Number(db.getSetting(LAST_SENT_KEY)) || null;
    return {
      enabled: enabled(),
      endpointConfigured: Boolean(env.TELEMETRY_ENDPOINT),
      /** Where the shared numbers are publicly visible — part of the deal. */
      statsUrl: env.TELEMETRY_ENDPOINT ? env.TELEMETRY_ENDPOINT.replace(/\/ping$/, '/stats') : null,
      lastSentAt,
      lastStatus: db.getSetting(LAST_STATUS_KEY),
      /** The literal payload the next ping would carry — the whole point. */
      payload: payload(),
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

  return { state, setEnabled, send, payload, startLoop };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
