import { request as httpsRequest } from 'node:https';
import type { PortForwardRule, RequiredForward } from '../unifi.js';
import { registerProvider, type RouterProvider } from './provider.js';

/**
 * MikroTik RouterOS 7, over its REST API (enabled by default on www-ssl).
 * Forwards are dstnat rules in /ip/firewall/nat; the portal's own carry a
 * comment prefix so it never touches hand-made rules, same as everywhere.
 *
 * RouterOS presents a self-signed certificate, so the certificate is pinned
 * on first connect — trust on first use, the way the UniFi provider and SSH
 * do it. Written to the RouterOS REST docs; flagged in ours as awaiting
 * real-hardware confirmation, and the connect test is a real call.
 */

const MANAGED_PREFIX = 'GameKeepr:';

class MikrotikError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

interface NatRule {
  '.id': string;
  chain?: string;
  action?: string;
  protocol?: string;
  'dst-port'?: string;
  'to-addresses'?: string;
  'to-ports'?: string;
  comment?: string;
  disabled?: string;
}

registerProvider({
  id: 'mikrotik',
  label: 'MikroTik (RouterOS 7)',
  fields: [
    { key: 'host', label: 'Router address', placeholder: 'https://192.168.88.1' },
    { key: 'username', label: 'User', placeholder: 'admin' },
    { key: 'password', label: 'Password', secret: true },
    { key: 'wanInterface', label: 'WAN interface list', placeholder: 'WAN', optional: true },
  ],
  create(config): RouterProvider {
    const host = String(config.host ?? '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://');
    const authorization = `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`).toString('base64')}`;
    const wanList = String(config.wanInterface ?? '').trim() || 'WAN';
    let observedFingerprint: string | null = null;

    function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const url = new URL(`${host}/rest${path}`);
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            host: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method,
            // Scoped to this client, never global; the pin below is the check.
            rejectUnauthorized: false,
            headers: { authorization, 'content-type': 'application/json' },
            timeout: 15_000,
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (text += chunk));
            res.on('end', () => {
              if (res.statusCode === 401) {
                return reject(new MikrotikError('The router rejected the username or password.', 'unauthorized'));
              }
              if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new MikrotikError(`RouterOS answered HTTP ${res.statusCode}: ${text.slice(0, 200)}`, 'http-error'));
              }
              try {
                resolve((text ? JSON.parse(text) : {}) as T);
              } catch {
                reject(new MikrotikError('RouterOS sent an unreadable answer.', 'bad-response'));
              }
            });
          },
        );
        req.on('socket', (socket) => {
          socket.on('secureConnect', () => {
            const cert = (socket as import('node:tls').TLSSocket).getPeerCertificate();
            observedFingerprint = cert?.fingerprint256 ?? null;
            if (config.fingerprint && observedFingerprint && observedFingerprint !== config.fingerprint) {
              req.destroy(
                new MikrotikError(
                  'The router presented a different certificate than the one saved. Reconnect it from Settings if you replaced the device.',
                  'fingerprint-changed',
                ),
              );
            }
          });
        });
        req.on('timeout', () => req.destroy(new MikrotikError('The router did not answer in time.', 'timeout')));
        req.on('error', (err) =>
          reject(err instanceof MikrotikError ? err : new MikrotikError(`Could not reach the router: ${err.message}`, 'unreachable')),
        );
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    }

    const toRule = (nat: NatRule): PortForwardRule => ({
      id: nat['.id'],
      name: nat.comment || `${nat.protocol ?? ''} ${nat['dst-port'] ?? ''}`.trim(),
      proto: nat.protocol ?? 'tcp',
      dstPort: nat['dst-port'] ?? '',
      fwd: nat['to-addresses'] ?? '',
      fwdPort: nat['to-ports'] ?? nat['dst-port'] ?? '',
      enabled: nat.disabled !== 'true',
      managed: (nat.comment ?? '').startsWith(MANAGED_PREFIX),
    });

    async function listNat(): Promise<NatRule[]> {
      const rules = await call<NatRule[]>('/ip/firewall/nat');
      return rules.filter((r) => r.chain === 'dstnat' && r.action === 'dst-nat');
    }

    async function addOne(target: string, port: string, protocol: 'tcp' | 'udp', name: string) {
      await call('/ip/firewall/nat', 'PUT', {
        chain: 'dstnat',
        action: 'dst-nat',
        protocol,
        'dst-port': port,
        'to-addresses': target,
        'to-ports': port,
        'in-interface-list': wanList,
        comment: `${MANAGED_PREFIX} ${name}`.slice(0, 60),
      });
    }

    return {
      id: 'mikrotik',
      label: 'MikroTik',
      async test() {
        const rules = await listNat();
        return {
          rules: rules.length,
          detail: `${rules.length} dst-nat rule(s), WAN interface list "${wanList}"`,
          fingerprint: observedFingerprint,
        };
      },
      list: async () => (await listNat()).map(toRule),
      async create(target: string, required: RequiredForward) {
        const protocols: Array<'tcp' | 'udp'> =
          required.proto === 'tcp_udp' ? ['tcp', 'udp'] : [required.proto];
        for (const protocol of protocols) await addOne(target, required.port, protocol, required.name);
        const created = (await listNat())
          .map(toRule)
          .find((r) => r.dstPort === required.port && r.fwd === target && r.managed);
        return (
          created ?? {
            id: `${required.proto}:${required.port}`,
            name: `${MANAGED_PREFIX} ${required.name}`,
            proto: required.proto,
            dstPort: required.port,
            fwd: target,
            fwdPort: required.port,
            enabled: true,
            managed: true,
          }
        );
      },
      async remove(id: string) {
        const rules = await listNat();
        const mine = rules.find((r) => r['.id'] === id);
        if (!mine) throw new MikrotikError('That rule no longer exists.', 'not-found');
        if (!(mine.comment ?? '').startsWith(MANAGED_PREFIX)) {
          throw new MikrotikError('That rule was not created by GameKeepr, so it will not be removed.', 'not-managed');
        }
        await call(`/ip/firewall/nat/${encodeURIComponent(id)}`, 'DELETE');
      },
    };
  },
});
