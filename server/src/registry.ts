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
  let configIds = new Set<string>();
  /**
   * Servers that exist only while something runs them — tournament match
   * servers. In memory only, never persisted: a portal restart re-registers
   * the ones whose containers still exist, and anything else is gone, which
   * is exactly what transient means.
   */
  const transient = new Map<string, ServerConfig>();

  /**
   * Config entries the owner deleted from the portal. The file itself is
   * mounted read-only on purpose (the portal never writes it), so "delete"
   * for a config server means: remember the id and stop listing it. The set
   * self-heals: an id no longer in the file is forgotten, so removing the
   * entry from servers.json and adding it back later shows it again.
   */
  const REMOVED_KEY = 'registry.removedConfigIds';

  function removedConfigIds(): Set<string> {
    try {
      const raw = db.getSetting(REMOVED_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function reload(): void {
    const managed: ServerConfig[] = [];

    for (const row of db.listManagedServers()) {
      const parsed = serverSchema.safeParse(row.definition);
      if (parsed.success) managed.push(parsed.data);
      // A definition that no longer validates is ignored rather than fatal:
      // the portal must still start after a schema change.
    }

    const removed = removedConfigIds();
    const pruned = [...removed].filter((id) => fileServers.some((s) => s.id === id));
    if (pruned.length !== removed.size) {
      db.setSetting(REMOVED_KEY, JSON.stringify(pruned));
    }
    const visibleFile = fileServers.filter((s) => !removed.has(s.id));

    // The config file wins on a duplicate id -- an operator editing the file
    // should never be overridden by something the portal wrote. Transient
    // entries come last and never shadow a real server.
    const seen = new Set(visibleFile.map((s) => s.id));
    const durable = [...visibleFile, ...managed.filter((s) => !seen.has(s.id))];
    const durableIds = new Set(durable.map((s) => s.id));
    cache = [...durable, ...[...transient.values()].filter((s) => !durableIds.has(s.id))];
    byId = new Map(cache.map((s) => [s.id, s]));
    configIds = seen;
  }

  reload();

  return {
    list: (): ServerConfig[] => cache,
    get: (id: unknown): ServerConfig | undefined =>
      typeof id === 'string' ? byId.get(id) : undefined,
    has: (id: string): boolean => byId.has(id),
    /** Whether this listed server's definition comes from config/servers.json. */
    isFromConfig: (id: string): boolean => configIds.has(id),
    /**
     * Delete, for a config server: the id joins the removed set and the entry
     * stops being listed. The file keeps its line (it is mounted read-only);
     * taking the line out of the file releases the id again.
     */
    removeConfigServer(id: string): void {
      const removed = removedConfigIds();
      removed.add(id);
      db.setSetting(REMOVED_KEY, JSON.stringify([...removed]));
      reload();
    },
    /** Called after a deploy or removal so the new server is live immediately. */
    reload,
    addTransient(server: ServerConfig): void {
      transient.set(server.id, { ...server, transient: true });
      reload();
    },
    removeTransient(id: string): void {
      if (transient.delete(id)) reload();
    },
  };
}

export type ServerRegistry = ReturnType<typeof createServerRegistry>;
