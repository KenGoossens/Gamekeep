import { createHash, randomUUID } from 'node:crypto';
import type { PortForwardRule, RequiredForward } from '../unifi.js';

/**
 * The SOAP spoken by two generations of home routers.
 *
 * UPnP-IGD (urn:schemas-upnp-org) and AVM's TR-064 (urn:dslforum-org) are the
 * same protocol wearing two namespaces: GetGenericPortMappingEntry walks the
 * table, AddPortMapping and DeletePortMapping edit it, argument names
 * identical. This module holds that shared half; the providers supply the
 * endpoint, the namespace and (for TR-064) the digest login.
 *
 * Parsing is deliberately a few regexes rather than an XML library: the
 * documents are machine-written, tiny and fixed-shape, and a parser would be
 * the only new dependency in the server.
 */

export class IgdError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Rules the portal created carry this, so it never touches anyone else's. */
const MANAGED_PREFIX = 'GameKeepr:';

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** First <Tag>value</Tag> in a document; the schemas never nest these. */
export function xmlValue(document: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(document);
  return match ? match[1]!.trim() : null;
}

const md5 = (text: string): string => createHash('md5').update(text).digest('hex');

/**
 * One round of HTTP digest auth, which is how TR-064 wants its password.
 * Parsed from the WWW-Authenticate challenge; only MD5/qop=auth, which is
 * what every Fritz!Box speaks.
 */
function digestHeader(
  challenge: string,
  method: string,
  uri: string,
  username: string,
  password: string,
): string {
  const field = (name: string): string =>
    new RegExp(`${name}="?([^",]+)"?`, 'i').exec(challenge)?.[1] ?? '';
  const realm = field('realm');
  const nonce = field('nonce');
  const cnonce = randomUUID().replace(/-/g, '').slice(0, 16);
  const nc = '00000001';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return (
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
    `qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`
  );
}

export interface SoapEndpoint {
  /** e.g. http://192.168.1.1:49000/upnp/control/wanipconnection1 */
  controlUrl: string;
  /** e.g. urn:dslforum-org:service:WANIPConnection:1 */
  serviceType: string;
  /** TR-064 wants a digest login; plain UPnP has none. */
  auth?: { username: string; password: string };
}

/** One SOAP action. Throws IgdError with the UPnP error code when refused. */
export async function soapCall(
  endpoint: SoapEndpoint,
  action: string,
  args: Record<string, string | number>,
): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${endpoint.serviceType}">
${Object.entries(args)
  .map(([key, value]) => `<${key}>${xmlEscape(String(value))}</${key}>`)
  .join('')}
</u:${action}></s:Body></s:Envelope>`;

  const headers: Record<string, string> = {
    'content-type': 'text/xml; charset="utf-8"',
    soapaction: `"${endpoint.serviceType}#${action}"`,
  };

  const send = (extra: Record<string, string>) =>
    fetch(endpoint.controlUrl, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body,
      signal: AbortSignal.timeout(10_000),
    });

  let response: Response;
  try {
    response = await send({});
    if (response.status === 401 && endpoint.auth) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      const uri = new URL(endpoint.controlUrl).pathname;
      response = await send({
        authorization: digestHeader(challenge, 'POST', uri, endpoint.auth.username, endpoint.auth.password),
      });
    }
  } catch (err) {
    throw new IgdError(`The router did not answer: ${(err as Error).message}`, 'unreachable');
  }

  const text = await response.text();
  if (response.status === 401) {
    throw new IgdError('The router rejected the username or password.', 'unauthorized');
  }
  if (!response.ok) {
    const code = xmlValue(text, 'errorCode') ?? String(response.status);
    throw new IgdError(
      `The router refused ${action} (${xmlValue(text, 'errorDescription') ?? `error ${code}`}).`,
      code,
    );
  }
  return text;
}

/** The SpecifiedArrayIndexInvalid family: "no more entries", not a failure. */
const END_OF_TABLE = new Set(['713', '714', '402']);

/**
 * The three port-mapping operations every IGD-style router shares. A
 * tcp_udp requirement becomes two mappings, which is how these boxes think.
 */
export function createIgdMappings(endpoint: SoapEndpoint) {
  async function list(): Promise<PortForwardRule[]> {
    const rules: PortForwardRule[] = [];
    for (let index = 0; index < 200; index++) {
      let document: string;
      try {
        document = await soapCall(endpoint, 'GetGenericPortMappingEntry', {
          NewPortMappingIndex: index,
        });
      } catch (err) {
        if (err instanceof IgdError && END_OF_TABLE.has(err.code)) break;
        throw err;
      }
      const port = xmlValue(document, 'NewExternalPort');
      const proto = (xmlValue(document, 'NewProtocol') ?? 'TCP').toLowerCase();
      if (!port) continue;
      const description = xmlValue(document, 'NewPortMappingDescription') ?? '';
      rules.push({
        id: `${proto}:${port}`,
        name: description || `${proto} ${port}`,
        proto,
        dstPort: port,
        fwd: xmlValue(document, 'NewInternalClient') ?? '',
        fwdPort: xmlValue(document, 'NewInternalPort') ?? port,
        enabled: (xmlValue(document, 'NewEnabled') ?? '1') === '1',
        managed: description.startsWith(MANAGED_PREFIX),
      });
    }
    return rules;
  }

  async function add(target: string, port: string, proto: 'TCP' | 'UDP', name: string): Promise<void> {
    await soapCall(endpoint, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: proto,
      NewInternalPort: port,
      NewInternalClient: target,
      NewEnabled: 1,
      NewPortMappingDescription: `${MANAGED_PREFIX} ${name}`.slice(0, 60),
      NewLeaseDuration: 0,
    });
  }

  async function create(target: string, required: RequiredForward): Promise<PortForwardRule> {
    const protocols: Array<'TCP' | 'UDP'> =
      required.proto === 'tcp_udp' ? ['TCP', 'UDP'] : [required.proto.toUpperCase() as 'TCP' | 'UDP'];
    for (const proto of protocols) await add(target, required.port, proto, required.name);
    return {
      id: `${protocols[0]!.toLowerCase()}:${required.port}`,
      name: `${MANAGED_PREFIX} ${required.name}`,
      proto: required.proto,
      dstPort: required.port,
      fwd: target,
      fwdPort: required.port,
      enabled: true,
      managed: true,
    };
  }

  async function remove(id: string): Promise<void> {
    const [proto, port] = id.split(':');
    if (!proto || !port || !/^\d+$/.test(port)) {
      throw new IgdError('That rule id is not one of this router’s.', 'bad-id');
    }
    // Only rules the portal made: the same guarantee the UniFi path gives.
    const current = await list();
    const mine = current.find((r) => r.id === id);
    if (!mine) throw new IgdError('That rule no longer exists.', 'not-found');
    if (!mine.managed) {
      throw new IgdError('That rule was not created by GameKeepr, so it will not be removed.', 'not-managed');
    }
    await soapCall(endpoint, 'DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: proto.toUpperCase(),
    });
  }

  return { list, create, remove };
}
