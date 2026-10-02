import { IgdError, createIgdMappings, xmlValue, type SoapEndpoint } from './igd.js';
import { registerProvider, type RouterProvider } from './provider.js';

/**
 * Plain UPnP-IGD: the port-mapping protocol most consumer routers (TP-Link,
 * Netgear, ASUS, many ISP boxes) answer when "UPnP" is switched on in their
 * settings. No login — which is exactly why some people switch it off; this
 * provider is for the households where it is on anyway.
 *
 * Discovery is normally multicast, which does not cross a Docker bridge, so
 * the operator gives the router's address and the description document is
 * fetched from the handful of ports vendors actually use.
 */

const DESCRIPTION_PATHS = [
  ':1900/igd.xml',
  ':5000/rootDesc.xml',
  ':2869/IGatewayDeviceDescDoc',
  ':80/rootDesc.xml',
  ':49000/igddesc.xml',
  ':8200/rootDesc.xml',
];

const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

async function discover(host: string): Promise<SoapEndpoint> {
  const base = host.replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
  for (const path of DESCRIPTION_PATHS) {
    const descriptionUrl = `${base}${path}`;
    let document: string;
    try {
      const response = await fetch(descriptionUrl, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) continue;
      document = await response.text();
    } catch {
      continue;
    }

    // The description nests services; find a WAN connection service and its
    // controlURL. Split per <service> block so the URL belongs to the match.
    for (const serviceType of WAN_SERVICES) {
      const block = document
        .split(/<service>/i)
        .find((part) => part.includes(serviceType));
      const controlPath = block ? xmlValue(block, 'controlURL') : null;
      if (!controlPath) continue;
      const controlUrl = controlPath.startsWith('http')
        ? controlPath
        : `${new URL(descriptionUrl).origin}${controlPath.startsWith('/') ? '' : '/'}${controlPath}`;
      return { controlUrl, serviceType };
    }
  }
  throw new IgdError(
    'No UPnP gateway description found on this address. Is UPnP enabled on the router?',
    'not-found',
  );
}

registerProvider({
  id: 'upnp',
  label: 'UPnP (TP-Link, Netgear, ASUS, most ISP routers)',
  fields: [
    { key: 'host', label: 'Router address', placeholder: '192.168.1.1' },
  ],
  create(config): RouterProvider {
    const host = String(config.host ?? '');
    // Re-discovered per call: control URLs move when a router reboots with a
    // fresh UUID, and the description fetch is a LAN round-trip, not a cost.
    return {
      id: 'upnp',
      label: 'UPnP',
      async test() {
        const endpoint = await discover(host);
        const rules = await createIgdMappings(endpoint).list();
        return { rules: rules.length, detail: `${endpoint.serviceType}, ${rules.length} existing mapping(s)` };
      },
      list: async () => createIgdMappings(await discover(host)).list(),
      create: async (target, required) => createIgdMappings(await discover(host)).create(target, required),
      remove: async (id) => createIgdMappings(await discover(host)).remove(id),
    };
  },
});
