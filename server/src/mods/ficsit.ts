import {
  fetchJson,
  registerSource,
  ModSourceError,
  type ModSource,
  type ModSummary,
  type ModVersion,
} from './sources.js';

/**
 * Satisfactory mods, from the official repository behind ficsit.app.
 *
 * The best-behaved source this portal talks to: it publishes a SHA-256 per
 * artefact, expresses dependencies as semver ranges, and -- decisively for a
 * dedicated server -- builds a separate LinuxServer target. Picking the wrong
 * target installs a 237 MB client build into a headless server, so the target
 * is chosen explicitly and a mod without one is reported as unsupported rather
 * than installed in a form that cannot work.
 */

const ENDPOINT = 'https://api.ficsit.app/v2/query';
/** The only build that belongs on a headless Linux dedicated server. */
const TARGET = 'LinuxServer';

interface GqlResponse<T> {
  data: T | null;
  errors?: Array<{ message: string }>;
}

interface GqlMod {
  id: string;
  name: string;
  mod_reference: string;
  short_description: string;
  authors?: Array<{ user: { username: string } }>;
  versions?: Array<{ targets?: Array<{ targetName: string }> }>;
}

interface GqlVersion {
  version: string;
  created_at: string | null;
  size: number | null;
  hash: string | null;
  dependencies: Array<{ mod_id: string; condition: string; optional: boolean }>;
  targets: Array<{ targetName: string; link: string; hash: string | null; size: number | null }>;
}

async function query<T>(gql: string, variables: Record<string, unknown> = {}): Promise<T> {
  const body = await fetchJson<GqlResponse<T>>(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables }),
  });

  // A GraphQL error arrives with HTTP 200, so the status alone proves nothing.
  if (!body.data) {
    throw new ModSourceError(
      body.errors?.[0]?.message ?? 'The mod repository returned no data.',
      'bad-response',
    );
  }
  return body.data;
}

function toSummary(mod: GqlMod): ModSummary {
  // Absent when the query did not ask for targets, which is not the same as
  // "no server build" -- so it stays null rather than becoming false.
  const targets = mod.versions?.[0]?.targets;
  return {
    source: 'ficsit',
    id: mod.mod_reference,
    name: mod.name,
    summary: mod.short_description ?? '',
    author: mod.authors?.map((a) => a.user.username).join(', ') ?? 'unknown',
    url: `https://ficsit.app/mod/${mod.mod_reference}`,
    // The repository has no deprecation flag of its own.
    deprecated: false,
    serverSupported: targets ? targets.some((t) => t.targetName === TARGET) : null,
  };
}

/*
 * The newest version's targets come back with the search, which is what lets
 * the list say up front that a mod is client-only. A great many Satisfactory
 * mods are: without this the operator finds out by clicking Check it and
 * getting an error, which reads like the portal is broken rather than like
 * the mod simply not having a server build.
 */
const SEARCH = `query($q: String!) {
  getMods(filter: { search: $q, limit: 60 }) {
    mods {
      id name mod_reference short_description
      authors { user { username } }
      versions(filter: { limit: 1 }) { targets { targetName } }
    }
  }
}`;

const LOOKUP = `query($ref: ModReference!) {
  getModByReference(modReference: $ref) {
    id name mod_reference short_description authors { user { username } }
  }
}`;

/*
 * sml_version is deliberately not requested: for SML itself the field errors,
 * and a GraphQL field error nulls the entire response. The same requirement is
 * carried in dependencies, which every mod has.
 */
const VERSIONS = `query($ref: ModReference!) {
  getModByReference(modReference: $ref) {
    versions(filter: { limit: 25 }) {
      version created_at size hash
      dependencies { mod_id condition optional }
      targets { targetName link hash size }
    }
  }
}`;

export const ficsitSource: ModSource = {
  id: 'ficsit',
  label: 'ficsit.app',
  searchable: true,
  lookupHint: 'A mod reference, such as RefinedPower.',
  loader: { id: 'SML', label: 'Satisfactory Mod Loader' },

  async search(q: string): Promise<ModSummary[]> {
    const data = await query<{ getMods: { mods: GqlMod[] } }>(SEARCH, { q });
    return (data.getMods?.mods ?? []).map(toSummary);
  },

  async lookup(reference: string): Promise<ModSummary> {
    const data = await query<{ getModByReference: GqlMod | null }>(LOOKUP, { ref: reference });
    if (!data.getModByReference) {
      throw new ModSourceError(`No mod called "${reference}" in this repository.`, 'not-found');
    }
    return toSummary(data.getModByReference);
  },

  async versions(id: string): Promise<ModVersion[]> {
    const data = await query<{ getModByReference: { versions: GqlVersion[] } | null }>(VERSIONS, {
      ref: id,
    });
    if (!data.getModByReference) {
      throw new ModSourceError(`No mod called "${id}" in this repository.`, 'not-found');
    }

    const out: ModVersion[] = [];
    for (const version of data.getModByReference.versions ?? []) {
      const target = version.targets?.find((t) => t.targetName === TARGET);
      // Silently skipped rather than offered: a version with no server build
      // is not a version of this mod that a dedicated server can run.
      if (!target) continue;

      out.push({
        version: version.version,
        releasedAt: version.created_at,
        // The target's own size and hash, never the mod-wide ones: those
        // describe the Windows client build.
        sizeBytes: target.size ?? null,
        hash: target.hash ? { algo: 'sha256' as const, value: target.hash } : null,
        downloadUrl: new URL(target.link, 'https://api.ficsit.app').toString(),
        dependencies: (version.dependencies ?? []).map((d) => ({
          id: d.mod_id,
          range: d.condition || null,
          optional: Boolean(d.optional),
        })),
      });
    }

    /*
     * Every version skipped means this is a client-only mod, and saying so is
     * the whole answer. Returning an empty list left the caller to report
     * "could not inspect that mod", which reads like the portal is broken
     * rather than like the mod simply having nothing a server can run.
     */
    if (out.length === 0) {
      const offered = new Set(
        (data.getModByReference.versions ?? []).flatMap((v) =>
          (v.targets ?? []).map((t) => t.targetName),
        ),
      );
      throw new ModSourceError(
        offered.size > 0
          ? `This is a client-only mod — it builds for ${[...offered].join(', ')} and has no dedicated-server version, so there is nothing to install here.`
          : 'This mod publishes no downloadable builds.',
        'no-server-build',
      );
    }
    return out;
  },
};

registerSource(ficsitSource);
