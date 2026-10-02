import { createIgdMappings, soapCall, type SoapEndpoint } from './igd.js';
import { registerProvider, type RouterProvider } from './provider.js';

/**
 * AVM Fritz!Box, over TR-064 — the router half of Belgian and Dutch living
 * rooms. TR-064 must be on (Home Network → Network → Network Settings →
 * "Allow access for applications") and the login is an ordinary Fritz!Box
 * user with "Fritz!Box settings" permission.
 *
 * Written to AVM's published TR-064 spec; flagged in the docs as awaiting
 * real-hardware confirmation. A mistake here fails loudly at connect time --
 * the test is a real call -- never silently later.
 */

/** DSL boxes route via PPP, cable/fiber ones via IP; ask the right table. */
const SERVICES = [
  { serviceType: 'urn:dslforum-org:service:WANPPPConnection:1', controlPath: '/upnp/control/wanpppconn1' },
  { serviceType: 'urn:dslforum-org:service:WANIPConnection:1', controlPath: '/upnp/control/wanipconnection1' },
];

registerProvider({
  id: 'fritzbox',
  label: 'Fritz!Box (TR-064)',
  fields: [
    { key: 'host', label: 'Fritz!Box address', placeholder: 'http://192.168.178.1' },
    { key: 'username', label: 'Fritz!Box user', placeholder: 'fritz1234' },
    { key: 'password', label: 'Password', secret: true },
  ],
  create(config): RouterProvider {
    const base = `${String(config.host ?? '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://')}:49000`
      // A pasted "http://192.168.178.1:49000" must not become ...:49000:49000.
      .replace(/:(\d+):49000$/, ':$1');
    const auth = { username: config.username ?? '', password: config.password ?? '' };

    async function endpoint(): Promise<SoapEndpoint> {
      let lastError: Error | null = null;
      for (const service of SERVICES) {
        const candidate: SoapEndpoint = {
          controlUrl: `${base}${service.controlPath}`,
          serviceType: service.serviceType,
          auth,
        };
        try {
          // The cheapest authenticated call there is; also proves the login.
          await soapCall(candidate, 'GetExternalIPAddress', {});
          return candidate;
        } catch (err) {
          lastError = err as Error;
        }
      }
      throw lastError ?? new Error('No TR-064 WAN service answered.');
    }

    return {
      id: 'fritzbox',
      label: 'Fritz!Box',
      async test() {
        const found = await endpoint();
        const rules = await createIgdMappings(found).list();
        return {
          rules: rules.length,
          detail: `TR-064 via ${found.serviceType.includes('PPP') ? 'PPP' : 'IP'} connection, ${rules.length} existing mapping(s)`,
        };
      },
      list: async () => createIgdMappings(await endpoint()).list(),
      create: async (target, required) => createIgdMappings(await endpoint()).create(target, required),
      remove: async (id) => createIgdMappings(await endpoint()).remove(id),
    };
  },
});
