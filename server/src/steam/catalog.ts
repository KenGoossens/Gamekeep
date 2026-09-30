/**
 * Which dedicated servers exist on Steam, and finding one by name.
 *
 * There is no single free answer. Valve retired the open GetAppList in
 * favour of IStoreService, which wants a (free) Steam Web API key; the
 * keyless store search only sees apps with a store page, and most dedicated
 * server tools have none. So this merges three routes, each honest about
 * what it covers:
 *
 * - With a key: the full app list, filtered to names containing "dedicated
 *   server", cached for a week. This is the "all of Steam" promise.
 * - Without one: the public store search, which finds the servers that have
 *   store pages, plus whatever the cache still holds.
 * - Always: pasting an app id or store URL, which needs neither.
 */

import { decryptSecret, encryptSecret } from '../secrets.js';
import { identifyGame } from '../games.js';
import type { Db } from '../db.js';
import type { Env } from '../config.js';

const KEY_SETTING = 'steam-integration';
const LIST_SETTING = 'steam-ds-list';
const LIST_TTL_MS = 7 * 24 * 3600_000;
const STORE_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const APP_LIST = 'https://api.steampowered.com/IStoreService/GetAppList/v1/';

export interface SteamCatalogEntry {
  appId: number;
  name: string;
  /** The Gamekeep registry's label when it recognises this game, else null. */
  known: string | null;
}

export interface SteamCatalogStatus {
  /** Whether a Steam Web API key is configured for the full catalogue. */
  haveKey: boolean;
  cachedCount: number;
  fetchedAt: number | null;
}

interface CachedList {
  fetchedAt: number;
  apps: Array<{ appid: number; name: string }>;
}

export function createSteamCatalog(deps: { db: Db; env: Env }) {
  const { db, env } = deps;

  function apiKey(): string | null {
    const raw = db.getSetting(KEY_SETTING);
    if (!raw) return null;
    const plain = decryptSecret(raw, env.SESSION_SECRET);
    if (!plain) return null;
    try {
      return (JSON.parse(plain) as { webApiKey?: string }).webApiKey || null;
    } catch {
      return null;
    }
  }

  function setApiKey(webApiKey: string): void {
    db.setSetting(KEY_SETTING, encryptSecret(JSON.stringify({ webApiKey }), env.SESSION_SECRET));
  }

  function cached(): CachedList | null {
    const raw = db.getSetting(LIST_SETTING);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedList;
    } catch {
      return null;
    }
  }

  function status(): SteamCatalogStatus {
    const list = cached();
    return {
      haveKey: apiKey() !== null,
      cachedCount: list?.apps.length ?? 0,
      fetchedAt: list?.fetchedAt ?? null,
    };
  }

  /**
   * Pulls Valve's full app list and keeps only the dedicated servers.
   *
   * Paginated on purpose -- the list is a few hundred thousand rows -- and
   * filtered per page so only the ~thousand relevant names are ever held.
   */
  async function refresh(): Promise<number> {
    const key = apiKey();
    if (!key) throw new Error('No Steam Web API key is configured.');

    const apps: Array<{ appid: number; name: string }> = [];
    let lastAppId = 0;
    for (let page = 0; page < 40; page++) {
      const url =
        `${APP_LIST}?key=${encodeURIComponent(key)}&include_games=true&include_software=true` +
        `&include_dlc=false&include_videos=false&include_hardware=false` +
        `&max_results=50000${lastAppId ? `&last_appid=${lastAppId}` : ''}`;
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'Gamekeep' },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 403) {
        throw new Error('Steam refused the Web API key. Check it on steamcommunity.com/dev/apikey.');
      }
      if (!response.ok) throw new Error(`Steam answered ${response.status}.`);
      const payload = (await response.json()) as {
        response?: {
          apps?: Array<{ appid: number; name: string }>;
          have_more_results?: boolean;
          last_appid?: number;
        };
      };
      const batch = payload.response?.apps ?? [];
      for (const app of batch) {
        if (/dedicated\s*server/i.test(app.name)) apps.push({ appid: app.appid, name: app.name });
      }
      if (!payload.response?.have_more_results) break;
      lastAppId = payload.response.last_appid ?? 0;
      if (!lastAppId) break;
    }

    apps.sort((a, b) => a.name.localeCompare(b.name));
    db.setSetting(LIST_SETTING, JSON.stringify({ fetchedAt: Date.now(), apps } as CachedList));
    return apps.length;
  }

  /** The keyless route: only servers with a store page, but always available. */
  async function storeSearch(query: string): Promise<Array<{ appid: number; name: string }>> {
    try {
      const response = await fetch(
        `${STORE_SEARCH}?term=${encodeURIComponent(query)}&l=english&cc=US`,
        { headers: { accept: 'application/json', 'user-agent': 'Gamekeep' }, signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        items?: Array<{ id: number; name: string }>;
      };
      return (payload.items ?? [])
        .filter((i) => /\bserver\b/i.test(i.name))
        .map((i) => ({ appid: i.id, name: i.name }));
    } catch {
      return [];
    }
  }

  function decorate(app: { appid: number; name: string }): SteamCatalogEntry {
    return {
      appId: app.appid,
      name: app.name,
      known: identifyGame(app.name, '')?.label ?? null,
    };
  }

  async function search(query: string): Promise<{ results: SteamCatalogEntry[]; stale: boolean }> {
    const q = query.trim().toLowerCase();
    const list = cached();
    const stale = list !== null && Date.now() - list.fetchedAt > LIST_TTL_MS;

    const fromCache = (list?.apps ?? []).filter((a) => a.name.toLowerCase().includes(q));
    const fromStore = q.length >= 3 ? await storeSearch(query) : [];

    const seen = new Set<number>();
    const merged: SteamCatalogEntry[] = [];
    for (const app of [...fromCache, ...fromStore]) {
      if (seen.has(app.appid)) continue;
      seen.add(app.appid);
      merged.push(decorate(app));
    }
    return { results: merged.slice(0, 50), stale };
  }

  return { status, setApiKey, refresh, search };
}

export type SteamCatalog = ReturnType<typeof createSteamCatalog>;
