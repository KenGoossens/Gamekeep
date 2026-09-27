/**
 * Looks up what an image actually is, without pulling it.
 *
 * A game server image is often a gigabyte or more, and the questions worth
 * asking -- which exact digest is this tag pointing at today, when was it last
 * built, does it run as root -- are all answered by a few kilobytes of
 * manifest and config. Pulling first would mean the operator has already
 * committed the disk and the bandwidth before seeing anything.
 *
 * Anonymous only. These are public images; a portal that stored registry
 * credentials would be holding yet another secret it has no need for.
 */

const DEFAULT_REGISTRY = 'registry-1.docker.io';
/** Config blobs are small; anything larger is not something to parse. */
const MAX_BLOB_BYTES = 1024 * 1024;

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface ImageReference {
  registry: string;
  repository: string;
  /** Tag or digest, whichever the reference gave. */
  reference: string;
  /** True when the reference already names an immutable digest. */
  pinned: boolean;
}

/** Splits "ghcr.io/ich777/steamcmd:valheim" into its parts. */
export function parseImageReference(image: string): ImageReference {
  let rest = image.trim();
  let registry = DEFAULT_REGISTRY;

  const slash = rest.indexOf('/');
  const head = slash === -1 ? '' : rest.slice(0, slash);
  // A first segment is a registry only if it looks like a host: Docker's own
  // rule, and the reason "ubuntu/nginx" is a Hub repository and not a host.
  if (head && (head.includes('.') || head.includes(':') || head === 'localhost')) {
    registry = head;
    rest = rest.slice(slash + 1);
  }

  let reference = 'latest';
  let pinned = false;
  const at = rest.indexOf('@');
  if (at !== -1) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
    pinned = true;
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > rest.lastIndexOf('/')) {
      reference = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }

  // Hub's own images live under library/ even though nobody writes it.
  const repository = registry === DEFAULT_REGISTRY && !rest.includes('/') ? `library/${rest}` : rest;
  return { registry, repository, reference, pinned };
}

/**
 * Registries answer 401 with the token service to ask, which is the documented
 * way to get an anonymous pull token rather than a hardcoded URL per registry.
 */
async function tokenFor(challenge: string): Promise<string | null> {
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return null;

  const url = new URL(realm);
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1];
  if (service) url.searchParams.set('service', service);
  if (scope) url.searchParams.set('scope', scope);

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const body = (await response.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

async function registryFetch(url: string, accept: string): Promise<Response> {
  const first = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (first.status !== 401) return first;

  const token = await tokenFor(first.headers.get('www-authenticate') ?? '');
  if (!token) return first;

  return fetch(url, {
    headers: { accept, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
}

interface Manifest {
  mediaType?: string;
  manifests?: Array<{
    digest: string;
    platform?: { os?: string; architecture?: string };
  }>;
  config?: { digest: string };
}

export interface ImageFacts {
  reference: ImageReference;
  /** The digest this tag resolves to right now. */
  digest: string | null;
  /** When the image was built, from its config blob. */
  createdAt: string | null;
  /** The user the image runs as; empty or "0" means root. */
  user: string | null;
  architecture: string | null;
  os: string | null;
  exposedPorts: string[];
}

/**
 * Resolves a tag to the facts worth judging. Throws only when the registry
 * cannot be reached or the image does not exist; a partial answer is returned
 * rather than nothing, because a missing created-date is still worth knowing
 * the digest for.
 */
export async function describeImage(image: string): Promise<ImageFacts> {
  const reference = parseImageReference(image);
  const base = `https://${reference.registry}/v2/${reference.repository}`;

  const response = await registryFetch(`${base}/manifests/${reference.reference}`, MANIFEST_TYPES);
  if (response.status === 404) {
    throw new RegistryError(`The registry has no image "${image}".`, 'not-found');
  }
  if (!response.ok) {
    throw new RegistryError(`The registry answered ${response.status}.`, 'bad-response');
  }

  let digest = response.headers.get('docker-content-digest');
  let manifest = (await response.json()) as Manifest;

  // A multi-architecture tag points at a list; the image that would actually
  // run here is the linux/amd64 entry.
  if (manifest.manifests?.length) {
    const picked =
      manifest.manifests.find(
        (m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64',
      ) ?? manifest.manifests[0];

    if (picked) {
      digest = picked.digest;
      const inner = await registryFetch(`${base}/manifests/${picked.digest}`, MANIFEST_TYPES);
      if (inner.ok) manifest = (await inner.json()) as Manifest;
    }
  }

  const facts: ImageFacts = {
    reference,
    digest,
    createdAt: null,
    user: null,
    architecture: null,
    os: null,
    exposedPorts: [],
  };

  const configDigest = manifest.config?.digest;
  if (!configDigest) return facts;

  const blob = await registryFetch(`${base}/blobs/${configDigest}`, 'application/json');
  if (!blob.ok) return facts;

  const length = Number(blob.headers.get('content-length') ?? 0);
  if (length > MAX_BLOB_BYTES) return facts;

  const config = (await blob.json()) as {
    created?: string;
    architecture?: string;
    os?: string;
    config?: { User?: string; ExposedPorts?: Record<string, unknown> };
  };

  facts.createdAt = config.created ?? null;
  facts.architecture = config.architecture ?? null;
  facts.os = config.os ?? null;
  facts.user = config.config?.User ?? null;
  facts.exposedPorts = Object.keys(config.config?.ExposedPorts ?? {});
  return facts;
}
