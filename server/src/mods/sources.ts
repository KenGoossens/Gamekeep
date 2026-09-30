import { gameByQueryType } from '../games.js';
/**
 * Where mods may come from.
 *
 * A mod is third-party code that will run inside the game server, so the set
 * of places one can arrive from is a trust decision, not a convenience. Only a
 * registered source can be installed from: there is no "paste a URL" path,
 * because a URL is exactly how a mod becomes something other than what the
 * repository published.
 */

export interface ModSummary {
  source: string;
  /** Stable identifier within the source; what the operator installs by. */
  id: string;
  name: string;
  summary: string;
  author: string;
  /** The mod's page, so an operator can read about it before installing. */
  url: string;
  /** The publisher marked it superseded or abandoned. */
  deprecated: boolean;
  /**
   * Whether a build exists that a dedicated server can run. Null when the
   * repository does not say -- which is different from "no", and the UI is
   * careful not to present it as one.
   */
  serverSupported?: boolean | null;
}

export interface ModDependency {
  id: string;
  /** Semver range, or null when the source does not express one. */
  range: string | null;
  optional: boolean;
}

export interface ModVersion {
  version: string;
  releasedAt: string | null;
  sizeBytes: number | null;
  /**
   * The publisher's own hash, under whichever algorithm they publish it --
   * ficsit states SHA-256, Modrinth SHA-512. Present means the download can be
   * proven to be exactly what they published; absent means it cannot, and the
   * UI says so rather than implying a check that never happened.
   */
  hash: { algo: 'sha256' | 'sha512' | 'sha1'; value: string } | null;
  downloadUrl: string;
  /** Suggested filename, for a game that takes the artefact as one file. */
  filename?: string;
  /**
   * What the publisher says this build is for. Stated rather than enforced:
   * the portal cannot always read a running game's own version, and a silent
   * pass would be a claim it has no grounds for.
   */
  compatibility?: { loaders: string[]; gameVersions: string[] };
  dependencies: ModDependency[];
}

export interface ModSource {
  readonly id: string;
  readonly label: string;
  /** False when the repository offers no usable search (see thunderstore.ts). */
  readonly searchable: boolean;
  /** How the operator is told to identify a mod when search is unavailable. */
  readonly lookupHint: string;
  search(query: string): Promise<ModSummary[]>;
  lookup(reference: string): Promise<ModSummary>;
  versions(id: string): Promise<ModVersion[]>;
  /**
   * The loader this source's mods need, so compatibility can be judged before
   * anything is downloaded. Null when the game needs none.
   */
  readonly loader: { id: string; label: string } | null;
}

export class ModSourceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const registry = new Map<string, ModSource>();

export function registerSource(source: ModSource): void {
  registry.set(source.id, source);
}

export function listSources(): ModSource[] {
  return [...registry.values()];
}

export function getSource(id: string): ModSource | null {
  return registry.get(id) ?? null;
}

/**
 * The source serving a given server type, or null when modding is unsupported.
 *
 * Driven by the games registry rather than a list on each source, so adding a
 * game is one entry in one file. It is also what lets Thunderstore serve
 * Valheim, V Rising and Lethal Company without knowing they exist: its
 * per-package endpoint is not community-scoped.
 */
export function sourceForGame(gameType: string | undefined): ModSource | null {
  const profile = gameByQueryType(gameType);
  return profile?.mods ? getSource(profile.mods.source) : null;
}

/** Shared fetch with a deadline, so a slow repository cannot wedge a request. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'GameKeepr', ...(rest.headers ?? {}) },
    });
  } catch (err) {
    throw new ModSourceError(`Could not reach the mod repository: ${(err as Error).message}`, 'unreachable');
  }

  if (!response.ok) {
    throw new ModSourceError(
      response.status === 404
        ? 'No such mod in this repository.'
        : `The mod repository answered ${response.status}.`,
      response.status === 404 ? 'not-found' : 'bad-response',
    );
  }
  return (await response.json()) as T;
}
