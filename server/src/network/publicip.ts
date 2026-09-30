/**
 * The address the outside world sees.
 *
 * Port forwards point at a LAN address, which is the half of the answer the
 * portal already knew. The other half -- what to actually give a friend -- is
 * the router's public address, and until now that meant going and looking it
 * up somewhere else.
 *
 * Asked of a service rather than derived: the portal sits behind NAT and has
 * no way to know its own public address from the inside. Cloudflare's trace
 * endpoint is first because this portal is very likely already behind
 * Cloudflare, so it is not a new party learning anything; the others are
 * fallbacks for when it is not.
 */

const SOURCES = [
  { name: 'Cloudflare', url: 'https://cloudflare.com/cdn-cgi/trace', kind: 'trace' as const },
  { name: 'ipify', url: 'https://api.ipify.org', kind: 'plain' as const },
  { name: 'icanhazip', url: 'https://icanhazip.com', kind: 'plain' as const },
];

/** It changes when the ISP says so, which is rarely. */
const CACHE_MS = 30 * 60_000;
/** A reply longer than this is not an IP address whatever else it is. */
const MAX_BYTES = 4096;

export interface PublicAddress {
  ip: string | null;
  source: string | null;
  checkedAt: number;
  /** Why it could not be found, when it could not. */
  error?: string;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function validate(raw: string): string | null {
  const value = raw.trim();
  if (IPV4.test(value)) {
    // Rejects 999.1.1.1, which matches the shape but is not an address.
    return value.split('.').every((o) => Number(o) <= 255) ? value : null;
  }
  return value.includes(':') && IPV6.test(value) ? value : null;
}

export function createPublicAddressLookup() {
  let cached: PublicAddress | null = null;

  async function ask(source: (typeof SOURCES)[number]): Promise<string | null> {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(6_000),
      headers: { accept: 'text/plain', 'user-agent': 'GameKeepr' },
    });
    if (!response.ok) return null;

    const body = (await response.text()).slice(0, MAX_BYTES);
    if (source.kind === 'plain') return validate(body);

    // Cloudflare answers key=value lines; ip= is the one that matters.
    const line = body.split('\n').find((l) => l.startsWith('ip='));
    return line ? validate(line.slice(3)) : null;
  }

  async function get(force = false): Promise<PublicAddress> {
    if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;

    const failures: string[] = [];
    for (const source of SOURCES) {
      try {
        const ip = await ask(source);
        if (ip) {
          cached = { ip, source: source.name, checkedAt: Date.now() };
          return cached;
        }
        failures.push(`${source.name} gave no usable answer`);
      } catch (err) {
        failures.push(`${source.name}: ${(err as Error).message}`);
      }
    }

    // Cached rather than retried on every request: a portal with no outbound
    // access would otherwise make three failing requests per page load.
    cached = {
      ip: null,
      source: null,
      checkedAt: Date.now(),
      error: failures.join('; '),
    };
    return cached;
  }

  return { get };
}

export type PublicAddressLookup = ReturnType<typeof createPublicAddressLookup>;
