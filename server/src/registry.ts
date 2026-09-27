import { serverSchema, type ServerConfig } from './config.js';
import type { Db } from './db.js';

/**
 * The single source of truth for which containers the portal may touch.
 *
 * Two sources are merged: the read-only config file (the static whitelist) and
 * servers the portal deployed itself, which live in the database. Everything
 * that reaches Docker goes through get() -- there is no other path from a
 * client-supplied id to a container name.
 */
export function createServerRegistry(fileServers: ServerConfig[], db: Db) {
  let cache: ServerConfig[] = [];
  let byId = new Map<string, ServerConfig>();

  function reload(): void {
    const managed: ServerConfig[] = [];

    for (const row of db.listManagedServers()) {
      const parsed = serverSchema.safeParse(row.definition);
      if (parsed.success) managed.push(parsed.data);
      // A definition that no longer validates is ignored rather than fatal:
      // the portal must still start after a schema change.
    }

    // The config file wins on a duplicate id -- an operator editing the file
    // should never be overridden by something the portal wrote.
    const seen = new Set(fileServers.map((s) => s.id));
    cache = [...fileServers, ...managed.filter((s) => !seen.has(s.id))];
    byId = new Map(cache.map((s) => [s.id, s]));
  }

  reload();

  return {
    list: (): ServerConfig[] => cache,
    get: (id: unknown): ServerConfig | undefined =>
      typeof id === 'string' ? byId.get(id) : undefined,
    has: (id: string): boolean => byId.has(id),
    /** Called after a deploy or removal so the new server is live immediately. */
    reload,
  };
}

export type ServerRegistry = ReturnType<typeof createServerRegistry>;
