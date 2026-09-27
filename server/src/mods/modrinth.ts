import {
  fetchJson,
  registerSource,
  ModSourceError,
  type ModSource,
  type ModSummary,
  type ModVersion,
} from './sources.js';

/**
 * Minecraft (Java) mods, from Modrinth.
 *
 * The best-behaved repository this portal talks to. Open, no key, a SHA-512
 * per file, real dependency records, and -- uniquely -- explicit statements of
 * which Minecraft versions and which loaders a build is for, plus whether it
 * is a server-side mod at all. That last one matters: a great many Minecraft
 * mods are client-only, and installing one on a dedicated server does nothing
 * but add a file.
 *
 * A Minecraft mod is a .jar, which the server reads itself, so it is installed
 * as a single file rather than unpacked.
 */

const BASE = 'https://api.modrinth.com/v2';

interface MrProject {
  slug: string;
  title: string;
  description: string;
  project_type: string;
  team?: string;
  server_side?: string;
  client_side?: string;
  status?: string;
}

interface MrVersion {
  id: string;
  name: string;
  version_number: string;
  date_published: string | null;
  game_versions: string[];
  loaders: string[];
  version_type: string;
  files: Array<{
    url: string;
    filename: string;
    primary: boolean;
    size: number;
    hashes: { sha512?: string; sha1?: string };
  }>;
  dependencies: Array<{
    project_id: string | null;
    version_id: string | null;
    dependency_type: string;
  }>;
}

function toSummary(p: MrProject): ModSummary {
  return {
    source: 'modrinth',
    id: p.slug,
    name: p.title,
    summary: p.description ?? '',
    author: '',
    url: `https://modrinth.com/mod/${p.slug}`,
    // Modrinth archives a project rather than flagging it deprecated.
    deprecated: p.status === 'archived',
    // 'unsupported' means the mod does nothing on a server; the other values
    // ('required', 'optional', 'unknown') all leave it worth offering.
    serverSupported: p.server_side ? p.server_side !== 'unsupported' : null,
  };
}

export const modrinthSource: ModSource = {
  id: 'modrinth',
  label: 'Modrinth',
  searchable: true,
  lookupHint: 'A Modrinth project slug, such as fabric-api.',
  // Which loader is a per-server choice (Fabric, Forge, NeoForge, Quilt), so
  // there is no single one to insist on; compatibility is judged per version.
  loader: null,

  async search(q: string): Promise<ModSummary[]> {
    const facets = encodeURIComponent('[["project_type:mod"],["server_side:required","server_side:optional"]]');
    const body = await fetchJson<{ hits: Array<MrProject & { project_id: string; author?: string }> }>(
      `${BASE}/search?query=${encodeURIComponent(q)}&limit=20&facets=${facets}`,
    );
    return (body.hits ?? []).map((hit) => ({ ...toSummary(hit), author: hit.author ?? '' }));
  },

  async lookup(reference: string): Promise<ModSummary> {
    const slug = reference.trim().replace(/^https?:\/\/modrinth\.com\/mod\//i, '').replace(/\/.*$/, '');
    if (!slug) throw new ModSourceError('Give a Modrinth project slug.', 'bad-reference');
    return toSummary(await fetchJson<MrProject>(`${BASE}/project/${encodeURIComponent(slug)}`));
  },

  async versions(id: string): Promise<ModVersion[]> {
    const versions = await fetchJson<MrVersion[]>(
      `${BASE}/project/${encodeURIComponent(id)}/version`,
    );

    const out: ModVersion[] = [];
    for (const version of versions.slice(0, 25)) {
      const file = version.files.find((f) => f.primary) ?? version.files[0];
      if (!file) continue;

      const sha512 = file.hashes?.sha512;
      const sha1 = file.hashes?.sha1;

      out.push({
        version: version.version_number,
        compatibility: { loaders: version.loaders, gameVersions: version.game_versions },
        releasedAt: version.date_published,
        sizeBytes: file.size ?? null,
        hash: sha512
          ? { algo: 'sha512', value: sha512 }
          : sha1
            ? { algo: 'sha1', value: sha1 }
            : null,
        downloadUrl: file.url,
        filename: file.filename,
        dependencies: version.dependencies
          .filter((d) => d.dependency_type === 'required' || d.dependency_type === 'optional')
          .flatMap((d) =>
            d.project_id
              ? [
                  {
                    id: d.project_id,
                    // Modrinth pins a dependency by version id, not by range.
                    range: null,
                    optional: d.dependency_type === 'optional',
                  },
                ]
              : [],
          ),
      });
    }

    if (out.length === 0) {
      throw new ModSourceError('That project publishes no downloadable files.', 'not-found');
    }
    return out;
  },
};

registerSource(modrinthSource);
