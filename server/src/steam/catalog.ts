/**
 * Which dedicated servers exist on Steam, and finding one by name.
 *
 * There is no live source for this any more. Valve retired the open
 * GetAppList in 2025, and its replacement (IStoreService, key or no key)
 * only returns apps with store pages -- which dedicated server tools do not
 * have; tested, it finds 12 of the ~580. So the complete list ships with
 * GameKeepr as data, exactly like the game registry does, taken from the last
 * full snapshot of Valve's own list. Two live routes keep it current enough:
 * the public store search catches newer servers that do have store pages,
 * and pasting an app id or URL works for absolutely anything, list or no
 * list.
 */

import { identifyGame } from '../games.js';
import { SNAPSHOT_DATE, STEAM_SERVERS } from './servers.data.js';

const STORE_SEARCH = 'https://store.steampowered.com/api/storesearch/';

export interface SteamCatalogEntry {
  appId: number;
  name: string;
  /** The GameKeepr registry's label when it recognises this game, else null. */
  known: string | null;
  /** The tool's own Steam client icon, when it has one. */
  iconUrl: string | null;
}

export interface SteamCatalogStatus {
  total: number;
  snapshotDate: string;
}

function decorate(app: { appid: number; name: string; icon?: string }): SteamCatalogEntry {
  return {
    appId: app.appid,
    name: app.name,
    known: identifyGame(app.name, '')?.label ?? null,
    iconUrl: app.icon
      ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${app.appid}/${app.icon}.jpg`
      : null,
  };
}

/**
 * Recognised games first, then alphabetical: the servers GameKeepr can give
 * ports, saves, mods and a player count belong at the top of the list, the
 * same way running servers sort first everywhere else.
 */
function ordered(entries: SteamCatalogEntry[]): SteamCatalogEntry[] {
  return entries.sort((a, b) => {
    if (Boolean(a.known) !== Boolean(b.known)) return a.known ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function createSteamCatalog() {
  function status(): SteamCatalogStatus {
    return { total: STEAM_SERVERS.length, snapshotDate: SNAPSHOT_DATE };
  }

  /** The keyless live route: only servers with a store page, but always fresh. */
  async function storeSearch(query: string): Promise<Array<{ appid: number; name: string }>> {
    try {
      const response = await fetch(
        `${STORE_SEARCH}?term=${encodeURIComponent(query)}&l=english&cc=US`,
        {
          headers: { accept: 'application/json', 'user-agent': 'GameKeepr' },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return [];
      const payload = (await response.json()) as { items?: Array<{ id: number; name: string }> };
      return (payload.items ?? [])
        .filter((i) => /\bserver\b/i.test(i.name))
        .map((i) => ({ appid: i.id, name: i.name }));
    } catch {
      return [];
    }
  }

  async function search(query: string): Promise<SteamCatalogEntry[]> {
    const q = query.trim().toLowerCase();

    // No query means the whole catalogue, like the Unraid tab: browsing is
    // the point, and 579 rows is a list, not a problem.
    if (!q) return ordered(STEAM_SERVERS.map(decorate));

    const fromList = STEAM_SERVERS.filter((a) => a.name.toLowerCase().includes(q));
    const fromStore = q.length >= 3 ? await storeSearch(query) : [];

    const seen = new Set<number>();
    const merged: SteamCatalogEntry[] = [];
    for (const app of [...fromList, ...fromStore]) {
      if (seen.has(app.appid)) continue;
      seen.add(app.appid);
      merged.push(decorate(app));
    }
    return ordered(merged);
  }

  return { status, search };
}

export type SteamCatalog = ReturnType<typeof createSteamCatalog>;
