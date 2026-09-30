import { request as httpsRequest } from 'node:https';
import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';

export interface PortForwardRule {
  id: string;
  name: string;
  proto: string;
  dstPort: string;
  fwd: string;
  fwdPort: string;
  enabled: boolean;
  managed: boolean;
}

/** A forward this server needs, derived from what its container publishes. */
export interface RequiredForward {
  proto: 'tcp' | 'udp' | 'tcp_udp';
  port: string;
  name: string;
  /**
   * True when the port looks like a management interface rather than the game
   * itself -- a web console, RCON, a query-only endpoint. Publishing those to
   * the internet is almost never what someone means by "let my friends in",
   * so the UI warns and never ticks them by default.
   */
  sensitive: boolean;
  reason?: string;
}

export interface UnifiConfig {
  host: string;
  apiKey: string;
  site: string;
  /**
   * SHA-256 fingerprint of the controller's certificate, remembered on first
   * connect. A UniFi console presents a self-signed certificate for
   * "unifi.local", so there is no authority to validate it against -- but
   * pinning the exact certificate still catches anyone stepping in between
   * later. Trust on first use, the way SSH does it.
   */
  fingerprint?: string;
}

/** Rules the portal created carry this prefix, so it never touches yours. */
const MANAGED_PREFIX = 'GameKeepr:';
/**
 * Rules created before the project was renamed. Kept so an existing install
 * can still recognise -- and therefore remove -- its own rules.
 */
const LEGACY_PREFIXES = ['GMPortal:'];

export class UnifiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function createUnifiClient(config: UnifiConfig) {
  const base = `${config.host.replace(/\/+$/, '')}/proxy/network/api/s/${config.site}`;

  /** Fingerprint seen on the most recent call, so it can be stored. */
  let observedFingerprint: string | null = null;

  function raw(path: string, method: string, body?: string): Promise<{ status: number; text: string }> {
    const url = new URL(`${base}${path}`);

    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method,
          // Scoped to this client only: never set globally, which would
          // also stop verifying Cloudflare, Steam and the app catalogue.
          rejectUnauthorized: false,
          headers: {
            'X-API-KEY': config.apiKey,
            'content-type': 'application/json',
          },
          timeout: 15_000,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );

      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate();
          observedFingerprint = cert?.fingerprint256 ?? null;
          if (config.fingerprint && observedFingerprint && observedFingerprint !== config.fingerprint) {
            req.destroy(
              new UnifiError(
                'The controller presented a different certificate than the one saved. Reconnect it from Settings if you replaced the device.',
                'fingerprint-changed',
              ),
            );
          }
        });
      });

      req.on('timeout', () => req.destroy(new UnifiError('The controller did not answer in time.', 'timeout')));
      req.on('error', (err) =>
        reject(
          err instanceof UnifiError
            ? err
            : new UnifiError(`Could not reach the UniFi controller: ${err.message}`, 'unreachable'),
        ),
      );

      if (body) req.write(body);
      req.end();
    });
  }

  async function call<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
    const { status, text } = await raw(path, init?.method ?? 'GET', init?.body);

    if (status === 401 || status === 403) {
      throw new UnifiError('The UniFi controller rejected the API key.', 'unauthorized');
    }
    if (status < 200 || status >= 300) {
      throw new UnifiError(`UniFi returned HTTP ${status}.`, 'http-error');
    }

    const body = JSON.parse(text) as { meta?: { rc?: string; msg?: string }; data?: T };
    if (body.meta?.rc && body.meta.rc !== 'ok') {
      throw new UnifiError(body.meta.msg ?? 'UniFi refused the request.', 'rejected');
    }
    return body.data as T;
  }
  interface RawRule {
    _id: string;
    name?: string;
    proto?: string;
    dst_port?: string;
    fwd?: string;
    fwd_port?: string;
    enabled?: boolean;
  }

  const toRule = (r: RawRule): PortForwardRule => ({
    id: r._id,
    name: r.name ?? '',
    proto: r.proto ?? 'tcp',
    dstPort: String(r.dst_port ?? ''),
    fwd: r.fwd ?? '',
    fwdPort: String(r.fwd_port ?? ''),
    enabled: r.enabled !== false,
    managed: [MANAGED_PREFIX, ...LEGACY_PREFIXES].some((p) => (r.name ?? '').startsWith(p)),
  });

  async function list(): Promise<PortForwardRule[]> {
    return (await call<RawRule[]>('/rest/portforward')).map(toRule);
  }

  async function test(): Promise<{ rules: number; site: string; fingerprint: string | null }> {
    const rules = await list();
    return { rules: rules.length, site: config.site, fingerprint: observedFingerprint };
  }

  async function create(
    target: string,
    required: RequiredForward,
  ): Promise<PortForwardRule> {
    const created = await call<RawRule[]>('/rest/portforward', {
      method: 'POST',
      body: JSON.stringify({
        name: `${MANAGED_PREFIX} ${required.name}`,
        enabled: true,
        pfwd_interface: 'wan',
        fwd: target,
        fwd_port: required.port,
        dst_port: required.port,
        proto: required.proto,
        src: 'any',
        log: false,
      }),
    });

    const rule = created[0];
    if (!rule) throw new UnifiError('UniFi accepted the rule but returned nothing.', 'no-result');
    return toRule(rule);
  }

  async function remove(id: string): Promise<void> {
    // Refuse to delete anything the portal did not create -- your own rules
    // are not ours to remove.
    const existing = (await list()).find((r) => r.id === id);
    if (!existing) throw new UnifiError('That rule no longer exists.', 'not-found');
    if (!existing.managed) {
      throw new UnifiError('That rule was not created by GameKeepr, so it will not be removed.', 'not-managed');
    }
    await call(`/rest/portforward/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  return { list, test, create, remove };
}

export type UnifiClient = ReturnType<typeof createUnifiClient>;

/**
 * Which forwards a server needs, read from the ports its container actually
 * publishes -- so this stays correct for any game without a per-game table.
 */
export async function requiredForwards(
  dockerClient: DockerClient,
  server: ServerConfig,
): Promise<RequiredForward[]> {
  const info = await dockerClient.docker.getContainer(server.container).inspect();
  const bindings = info.HostConfig?.PortBindings ?? {};

  // A port published on both protocols becomes one tcp_udp rule, which is how
  // a person would write it by hand.
  const byPort = new Map<string, Set<string>>();
  for (const [key, value] of Object.entries(bindings)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const [containerPort, protocol] = key.split('/');
    const hostPort = (value[0] as { HostPort?: string })?.HostPort || containerPort;
    if (!hostPort) continue;
    if (!byPort.has(hostPort)) byPort.set(hostPort, new Set());
    byPort.get(hostPort)!.add(protocol === 'udp' ? 'udp' : 'tcp');
  }

  return [...byPort.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([port, protocols]) => {
      const warning = sensitivePort(port, info.Config?.Env ?? []);
      return {
        port,
        proto: protocols.size > 1 ? ('tcp_udp' as const) : (([...protocols][0] ?? 'tcp') as 'tcp' | 'udp'),
        name: `${server.displayName} ${port}`,
        sensitive: Boolean(warning),
        reason: warning ?? undefined,
      };
    });
}

/**
 * Recognises administrative ports. The environment is consulted too: an image
 * that sets WEBUI_PORT or RCON_PORT is telling us exactly which port that is.
 */
function sensitivePort(port: string, env: string[]): string | null {
  const wellKnown: Record<string, string> = {
    '8222': 'web console',
    '8080': 'web interface',
    '8443': 'web interface',
    '9090': 'web interface',
    '25575': 'RCON (remote console)',
    '27020': 'RCON (remote console)',
    '7778': 'query port',
  };
  if (wellKnown[port]) return wellKnown[port];

  for (const entry of env) {
    const index = entry.indexOf('=');
    const key = entry.slice(0, index).toUpperCase();
    const value = entry.slice(index + 1);
    if (value !== port) continue;
    if (key.includes('WEBUI') || key.includes('WEB_UI')) return 'web console';
    if (key.includes('RCON')) return 'RCON (remote console)';
    if (key.includes('ADMIN')) return 'admin port';
  }
  return null;
}

/** Does an existing rule already cover this requirement? */
export function coveredBy(rule: PortForwardRule, need: RequiredForward, target: string): boolean {
  if (rule.fwd !== target || !rule.enabled) return false;

  const protoOk =
    rule.proto === need.proto || rule.proto === 'tcp_udp' || need.proto === 'tcp_udp';
  if (!protoOk) return false;

  // A rule may express a range, e.g. 2456-2458 covering 2456.
  const [from, to] = rule.dstPort.split('-').map(Number);
  const wanted = Number(need.port);
  if (!Number.isFinite(from)) return false;
  return to ? wanted >= from! && wanted <= to : wanted === from;
}
