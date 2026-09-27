import {
  fetchJson,
  registerSource,
  ModSourceError,
  type ModSource,
  type ModSummary,
  type ModVersion,
} from './sources.js';

/**
 * Valheim mods, from Thunderstore.
 *
 * Thunderstore has no usable search: the filtered endpoints answer 403 behind
 * Cloudflare, and the only complete index is a single 170 MB document listing
 * every version of all 108k packages, which is not something to fetch to
 * answer a search box. Mods are therefore identified exactly -- by package URL
 * or "Author/Name" -- and looked up one at a time, which costs about a
 * kilobyte. That is a real limitation of the repository, stated plainly in the
 * UI rather than papered over with a slow, stale local index.
 *
 * It publishes no hash, so a download from here can be checked for shape and
 * scanned, but not proven to be byte-for-byte what the author uploaded.
 */

const BASE = 'https://thunderstore.io/api/experimental/package';

interface TsVersion {
  namespace: string;
  name: string;
  version_number: string;
  full_name: string;
  description: string;
  download_url: string;
  date_created: string | null;
  dependencies: string[];
  file_size?: number;
}

interface TsPackage {
  namespace: string;
  name: string;
  full_name: string;
  owner: string;
  package_url: string;
  is_deprecated: boolean;
  latest: TsVersion;
}

/** Accepts a package URL, "Author/Name" or "Author-Name". */
function splitReference(reference: string): { namespace: string; name: string } {
  const text = reference.trim();

  const url = /thunderstore\.io\/(?:c\/[^/]+\/)?p(?:ackage)?\/([^/]+)\/([^/?#]+)/i.exec(text);
  if (url) return { namespace: url[1]!, name: url[2]! };

  const slash = /^([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (slash) return { namespace: slash[1]!, name: slash[2]! };

  // "Author-Name" is Thunderstore's own full_name form, but a package name may
  // itself contain a hyphen, so only the first one can be the separator.
  const dash = /^([^-\s]+)-(.+)$/.exec(text);
  if (dash) return { namespace: dash[1]!, name: dash[2]! };

  throw new ModSourceError(
    'Give the mod as a Thunderstore URL or as Author/ModName.',
    'bad-reference',
  );
}

function toSummary(pkg: TsPackage): ModSummary {
  return {
    source: 'thunderstore',
    id: `${pkg.namespace}/${pkg.name}`,
    name: pkg.name.replace(/_/g, ' '),
    summary: pkg.latest?.description ?? '',
    author: pkg.owner ?? pkg.namespace,
    url: pkg.package_url,
    deprecated: Boolean(pkg.is_deprecated),
  };
}

/**
 * Thunderstore states dependencies as full package names with the version
 * pinned into them, e.g. "denikson-BepInExPack_Valheim-5.4.2351".
 */
function parseDependency(fullName: string): { id: string; range: string | null } {
  const match = /^(.+)-(\d+\.\d+\.\d+)$/.exec(fullName);
  if (!match) return { id: fullName, range: null };

  const withoutVersion = match[1]!;
  const firstDash = withoutVersion.indexOf('-');
  const id =
    firstDash === -1
      ? withoutVersion
      : `${withoutVersion.slice(0, firstDash)}/${withoutVersion.slice(firstDash + 1)}`;
  // A pinned version is a floor, not an exact match: Thunderstore packages are
  // installed at their latest compatible version in practice.
  return { id, range: `>=${match[2]}` };
}

export const thunderstoreSource: ModSource = {
  id: 'thunderstore',
  label: 'Thunderstore',
  gameTypes: ['valheim'],
  searchable: false,
  lookupHint: 'A Thunderstore package URL, or Author/ModName.',
  loader: { id: 'denikson/BepInExPack_Valheim', label: 'BepInEx' },

  async search(): Promise<ModSummary[]> {
    throw new ModSourceError(
      'Thunderstore offers no search endpoint; look the mod up by URL instead.',
      'not-searchable',
    );
  },

  async lookup(reference: string): Promise<ModSummary> {
    const { namespace, name } = splitReference(reference);
    const pkg = await fetchJson<TsPackage>(
      `${BASE}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`,
    );
    return toSummary(pkg);
  },

  async versions(id: string): Promise<ModVersion[]> {
    const { namespace, name } = splitReference(id);
    const pkg = await fetchJson<TsPackage & { versions?: TsVersion[] }>(
      `${BASE}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`,
    );

    // The experimental endpoint returns the latest version in full; older ones
    // are addressed individually, which is more requests than a listing is
    // worth here.
    const versions = pkg.versions?.length ? pkg.versions : pkg.latest ? [pkg.latest] : [];
    return versions.map((v) => ({
      version: v.version_number,
      releasedAt: v.date_created,
      sizeBytes: v.file_size ?? null,
      // Thunderstore publishes none.
      sha256: null,
      downloadUrl: v.download_url,
      dependencies: (v.dependencies ?? []).map((d) => {
        const { id: depId, range } = parseDependency(d);
        return { id: depId, range, optional: false };
      }),
    }));
  },
};

registerSource(thunderstoreSource);
