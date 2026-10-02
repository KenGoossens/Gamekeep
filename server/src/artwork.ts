import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServerConfig } from './config.js';
import { gameByQueryType } from './games.js';

export type ArtworkKind = 'poster' | 'hero' | 'logo' | 'icon';

/**
 * Steam art, for anything with an app id. The poster is a chain, not one
 * file: smaller titles never got library assets (Soulmask sat on a lettered
 * tile for exactly this), but header.jpg exists for essentially every app on
 * the store, so walking the chain is what makes "a card always has a picture"
 * a guarantee instead of a hope.
 */
const STEAM_FILES: Record<'poster' | 'hero' | 'logo', string[]> = {
  poster: ['library_600x900.jpg', 'capsule_616x368.jpg', 'header.jpg'],
  hero: ['library_hero.jpg', 'capsule_616x368.jpg', 'header.jpg'],
  logo: ['logo.png'],
};

export const ARTWORK_KINDS: ArtworkKind[] = ['poster', 'hero', 'logo', 'icon'];

/**
 * Icons for games that are not on Steam. dashboard-icons is the icon set the
 * self-hosted dashboards use, so a server id like "minecraft" usually just
 * works without any configuration.
 */
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  gif: 'image/gif',
};

const ICON_EXTENSIONS = ['png', 'svg', 'webp', 'jpg'];
const MAX_BYTES = 8 * 1024 * 1024;

export function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Downloads each game's artwork once and serves it from the portal afterwards.
 *
 * Caching it locally rather than hotlinking means a viewer's browser never
 * talks to Valve or a CDN, the portal still looks right with no internet, and
 * nothing about which games you run leaks to a third party. It lives on the
 * data volume, so adding a game needs no rebuild -- just a restart.
 */
export function createArtworkStore(databasePath: string) {
  const root = join(dirname(databasePath), 'artwork');

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  async function download(url: string, destination: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      if (!response.ok) return false;

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return false;

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, buffer);
      return true;
    } catch {
      return false;
    }
  }

  /** Finds a stored file for a kind, whatever extension it was saved under. */
  async function resolve(serverId: string, kind: ArtworkKind): Promise<string | null> {
    const candidates =
      kind === 'icon'
        ? ICON_EXTENSIONS.map((ext) => join(root, serverId, `icon.${ext}`))
        : [join(root, serverId, `${kind}.${kind === 'logo' ? 'png' : 'jpg'}`)];

    for (const path of candidates) {
      if (await exists(path)) return path;
    }
    return null;
  }

  /**
   * A per-server id wins, but hardly anyone sets one: the game registry knows
   * the Steam id for every game it recognises. The same fallback notifications
   * use -- without it, a hand-configured server whose author never filled in
   * steamAppId sat on a lettered tile while its game had poster art all along.
   */
  function steamIdOf(server: ServerConfig): number | undefined {
    return server.steamAppId ?? gameByQueryType(server.query?.type)?.steamAppId;
  }

  async function ensureSteam(server: ServerConfig, log: (m: string) => void) {
    for (const kind of ['poster', 'hero', 'logo'] as const) {
      if (await resolve(server.id, kind)) continue;
      const file = join(root, server.id, `${kind}.${kind === 'logo' ? 'png' : 'jpg'}`);
      let got: string | null = null;
      for (const candidate of STEAM_FILES[kind]) {
        const url = `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamIdOf(server)}/${candidate}`;
        if (await download(url, file)) {
          got = candidate;
          break;
        }
      }
      log(got ? `artwork: fetched ${server.id}/${kind} (${got})` : `artwork: no ${kind} for ${server.id}`);
    }
  }

  async function ensureIcon(server: ServerConfig, log: (m: string) => void) {
    if (await resolve(server.id, 'icon')) return;

    // An explicit URL wins; otherwise guess the icon set from the server id,
    // which covers most games without any configuration at all.
    const url = server.iconUrl ?? `${ICON_CDN}/${encodeURIComponent(server.id)}.png`;
    const ext = (url.split('?')[0]?.split('.').pop() ?? 'png').toLowerCase();
    const safeExt = ICON_EXTENSIONS.includes(ext) ? ext : 'png';

    const ok = await download(url, join(root, server.id, `icon.${safeExt}`));
    log(
      ok
        ? `artwork: fetched ${server.id}/icon`
        : `artwork: no icon for ${server.id} (tried ${url})`,
    );
  }

  /**
   * Fills any gaps for the configured servers. Never throws and never blocks
   * startup on the network: a missing image degrades to a lettered tile.
   */
  async function ensure(servers: ServerConfig[], log: (message: string) => void): Promise<void> {
    for (const server of servers) {
      if (steamIdOf(server)) await ensureSteam(server, log);
      else await ensureIcon(server, log);
    }
  }

  /** Which presentation the UI should use for this server. */
  async function styleFor(server: ServerConfig): Promise<'poster' | 'icon' | 'none'> {
    if (steamIdOf(server) && (await resolve(server.id, 'poster'))) return 'poster';
    if (await resolve(server.id, 'icon')) return 'icon';
    return 'none';
  }

  return { ensure, resolve, styleFor, root };
}

export type ArtworkStore = ReturnType<typeof createArtworkStore>;
