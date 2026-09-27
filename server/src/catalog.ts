import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FEED_URL = 'https://assets.ca.unraid.net/feed/applicationFeed.json';
const FEED_TTL_MS = 6 * 60 * 60 * 1000;
// Bumped whenever the cached shape changes, so an old cache is discarded.
const CACHE_VERSION = 2;
const FEED_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Publishers whose game-server templates may be deployed.
 *
 * Deploying a container is root-equivalent on the host, so this is not a
 * convenience filter -- it is the list of people being trusted with that. The
 * default covers the well-known Unraid game-server maintainers; extend it with
 * TRUSTED_PUBLISHERS in .env, deliberately.
 */
export const DEFAULT_TRUSTED_PUBLISHERS = [
  'ich777',
  'binhex',
  'linuxserver',
  'mainfrezzer',
  'phasecorex',
  'pterodactyl',
  'lodestone-team',
];

export interface CatalogApp {
  id: string;
  name: string;
  repository: string;
  publisher: string;
  icon: string | null;
  overview: string;
  project: string | null;
  support: string | null;
  downloads: number;
  /**
   * The feed carries each app's full container definition, so there is no
   * second XML download: ports, paths and variables all come from here.
   */
  network: string;
  privileged: boolean;
  fields: TemplateField[];
}

export interface TemplateField {
  name: string;
  target: string;
  type: 'Path' | 'Variable' | 'Port' | 'Device' | 'Label' | 'other';
  mode: string;
  value: string;
  required: boolean;
  masked: boolean;
  description: string;
}

export interface ParsedTemplate {
  name: string;
  repository: string;
  network: string;
  privileged: boolean;
  icon: string | null;
  webUi: string | null;
  fields: TemplateField[];
}

const fieldType = (raw: string): TemplateField['type'] => {
  const t = raw.trim();
  return t === 'Path' || t === 'Variable' || t === 'Port' || t === 'Device' || t === 'Label'
    ? t
    : 'other';
};

/** Reads the feed's Config array into the fields we actually deploy from. */
function readFields(raw: unknown): TemplateField[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.flatMap((item) => {
    const entry = item as { '@attributes'?: Record<string, unknown>; value?: unknown };
    const attrs = entry['@attributes'] ?? {};
    const target = String(attrs.Target ?? '').trim();
    if (!target) return [];
    return [
      {
        name: String(attrs.Name ?? target).trim(),
        target,
        type: fieldType(String(attrs.Type ?? '')),
        mode: String(attrs.Mode ?? '').trim(),
        value: String(entry.value ?? attrs.Default ?? '').trim(),
        required: String(attrs.Required ?? '').toLowerCase() === 'true',
        masked: String(attrs.Mask ?? '').toLowerCase() === 'true',
        description: String(attrs.Description ?? '').slice(0, 400),
      },
    ];
  });
}

const publisherOf = (repository: string): string => {
  // ghcr.io/ich777/steamcmd:valheim -> ich777 ; binhex/arch-x:latest -> binhex
  const withoutTag = repository.split(':')[0] ?? '';
  const parts = withoutTag.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  // Drop a leading registry host such as ghcr.io, lscr.io or docker.io.
  if (parts.length > 1 && parts[0]!.includes('.')) return parts[1] ?? '';
  return parts[0] ?? '';
};

export function createCatalog(databasePath: string, trusted: string[]) {
  const cacheFile = join(dirname(databasePath), 'catalog.json');
  const trustedSet = new Set(trusted.map((t) => t.toLowerCase()));
  let apps: CatalogApp[] | null = null;
  let fetchedAt = 0;

  function isTrusted(repository: string): boolean {
    return trustedSet.has(publisherOf(repository).toLowerCase());
  }

  function toApp(raw: Record<string, unknown>): CatalogApp | null {
    const repository = String(raw.Repository ?? '').trim();
    const name = String(raw.Name ?? '').trim();
    if (!repository || !name) return null;

    return {
      id: `${publisherOf(repository)}/${name}`.toLowerCase(),
      name,
      repository,
      publisher: publisherOf(repository),
      icon: raw.Icon ? String(raw.Icon) : null,
      overview: String(raw.Overview ?? '').slice(0, 2000),
      project: raw.Project ? String(raw.Project) : null,
      support: raw.Support ? String(raw.Support) : null,
      downloads: Number(raw.downloads ?? 0) || 0,
      network: String(raw.Network ?? 'bridge').trim() || 'bridge',
      privileged: String(raw.Privileged ?? 'false').toLowerCase() === 'true',
      fields: readFields(raw.Config),
    };
  }

  /** Only game servers from trusted publishers ever enter the cache. */
  function extract(feed: unknown): CatalogApp[] {
    const list = (feed as { applist?: unknown[] })?.applist ?? [];
    const out: CatalogApp[] = [];

    for (const raw of list) {
      const entry = raw as Record<string, unknown>;
      const categories = Array.isArray(entry.CategoryList) ? entry.CategoryList : [];
      if (!categories.some((c) => /gameserver/i.test(String(c)))) continue;
      if (entry.Deprecated === true || entry.Blacklist === true) continue;

      const app = toApp(entry);
      if (!app || !isTrusted(app.repository)) continue;
      out.push(app);
    }

    out.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
    return out;
  }

  async function loadCache(): Promise<CatalogApp[] | null> {
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as {
        version?: number;
        fetchedAt: number;
        apps: CatalogApp[];
      };
      if (!Array.isArray(raw.apps) || raw.version !== CACHE_VERSION) return null;
      fetchedAt = raw.fetchedAt ?? 0;
      return raw.apps;
    } catch {
      return null;
    }
  }

  /**
   * The upstream feed is ~18 MB of mostly non-game apps, so it is filtered down
   * to the few hundred entries we care about and cached on the data volume.
   */
  async function refresh(): Promise<CatalogApp[]> {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Community Applications feed returned HTTP ${response.status}`);

    const text = await response.text();
    if (text.length > FEED_MAX_BYTES) throw new Error('Feed was unexpectedly large; refusing it.');

    const extracted = extract(JSON.parse(text));
    apps = extracted;
    fetchedAt = Date.now();

    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, fetchedAt, apps: extracted }));
    return extracted;
  }

  async function list(force = false): Promise<{ apps: CatalogApp[]; fetchedAt: number }> {
    if (!apps) apps = await loadCache();
    if (force || !apps || Date.now() - fetchedAt > FEED_TTL_MS) {
      try {
        await refresh();
      } catch (err) {
        // A stale catalogue is far better than no catalogue.
        if (!apps) throw err;
      }
    }
    return { apps: apps ?? [], fetchedAt };
  }

  async function find(id: string): Promise<CatalogApp | undefined> {
    const { apps: all } = await list();
    return all.find((a) => a.id === id);
  }

  /**
   * The app's container definition, straight from the cached feed. A handful of
   * entries ship without one and simply cannot be deployed.
   */
  function template(app: CatalogApp): ParsedTemplate {
    if (app.fields.length === 0) {
      throw new Error(`${app.name} does not publish a container definition, so it cannot be deployed from here.`);
    }
    return {
      name: app.name,
      repository: app.repository,
      network: app.network,
      privileged: app.privileged,
      icon: app.icon,
      webUi: null,
      fields: app.fields,
    };
  }

  return { list, find, template, refresh, isTrusted, publisherOf };
}

export type Catalog = ReturnType<typeof createCatalog>;
