import { createUnifiClient } from '../unifi.js';
import { registerProvider, type RouterProvider } from './provider.js';

/** UniFi consoles: Dream Machine, UDM Pro, Cloud Key, self-hosted controller. */
registerProvider({
  id: 'unifi',
  label: 'UniFi (Dream Machine, Cloud Key, controller)',
  fields: [
    { key: 'host', label: 'Controller address', placeholder: 'https://192.168.1.1' },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'site', label: 'Site', placeholder: 'default', optional: true },
  ],
  create(config): RouterProvider {
    const client = createUnifiClient({
      host: config.host ?? '',
      apiKey: config.apiKey ?? '',
      site: config.site || 'default',
      fingerprint: config.fingerprint,
    });

    return {
      id: 'unifi',
      label: 'UniFi',
      async test() {
        const result = await client.test();
        return {
          rules: result.rules,
          detail: `site ${result.site}, ${result.rules} existing rules`,
          fingerprint: result.fingerprint,
        };
      },
      list: () => client.list(),
      create: (target, required) => client.create(target, required),
      remove: (id) => client.remove(id),
    };
  },
});
