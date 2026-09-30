import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { Env } from './config.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import type { ServerRegistry } from './registry.js';
import { decryptSecret } from './secrets.js';
import { buildProvider } from './router/provider.js';
// Registering a provider is a side effect of importing it. Relying on some
// other module having done that first would make this check silently report
// "unknown router type" if load order ever changed.
import './router/unifi-provider.js';

/**
 * A read-only view of everything this portal depends on.
 *
 * The operator can see *that* each connection is healthy and *where* its
 * credential lives, but no credential is ever returned -- the panel exists so
 * nobody has to keep that map in their head, not so the portal becomes a vault.
 * Holding, say, a Cloudflare account token here would make an operator password
 * equivalent to control of the whole domain, including the ability to remove
 * the gate protecting this portal.
 *
 * Every check is bounded and independent: a router that has gone away must not
 * stop the page from telling you the rest is fine.
 */

export type CheckState = 'ok' | 'warn' | 'bad' | 'off' | 'unknown';

export interface Check {
  id: string;
  label: string;
  state: CheckState;
  /** One line, written to be read at a glance. */
  summary: string;
  /** What to do about it, shown when the state is not plain 'ok'. */
  detail?: string;
  /** Where this connection's credential lives, if it has one. */
  secretHome?: string;
  facts: Array<{ k: string; v: string }>;
}

export interface HealthReport {
  checkedAt: number;
  checks: Check[];
}

const CACHE_MS = 20_000;
/** No single check may hold up the report. */
const CHECK_TIMEOUT_MS = 8_000;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Runs one check, turning any throw or hang into an honest 'unknown'. */
async function run(
  id: string,
  label: string,
  fn: () => Promise<Omit<Check, 'id' | 'label'>>,
): Promise<Check> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS).unref(),
  );
  try {
    return { id, label, ...(await Promise.race([fn(), timeout])) };
  } catch (err) {
    return {
      id,
      label,
      state: 'unknown',
      summary: 'Could not be checked.',
      detail: (err as Error).message,
      facts: [],
    };
  }
}

/**
 * Takes only the four pieces it reads, rather than the whole app context --
 * the context would otherwise have to contain the reporter that contains it.
 */
export function createHealthReporter(deps: {
  env: Env;
  db: Db;
  docker: DockerClient;
  registry: ServerRegistry;
}) {
  const { env, db, docker, registry } = deps;
  let cached: HealthReport | null = null;

  // ---- Docker -----------------------------------------------------------
  async function checkDocker(): Promise<Omit<Check, 'id' | 'label'>> {
    const endpoint = env.DOCKER_HOST ?? env.DOCKER_SOCKET_PATH;
    const alive = await docker.ping();
    if (!alive) {
      return {
        state: 'bad',
        summary: 'Not reachable.',
        detail:
          'Without Docker the portal cannot see or restart anything. Check that the socket is mounted into this container.',
        facts: [{ k: 'Endpoint', v: endpoint }],
      };
    }

    let version = 'unknown';
    try {
      const v = (await docker.docker.version()) as { Version?: string };
      version = v.Version ?? 'unknown';
    } catch {
      // A working ping is enough; the version is decoration.
    }
    return {
      state: 'ok',
      summary: 'Connected.',
      facts: [
        { k: 'Endpoint', v: endpoint },
        { k: 'Engine', v: version },
      ],
    };
  }

  // ---- the public entrance ----------------------------------------------
  /**
   * Asks the internet what an anonymous visitor gets, from inside the
   * container. Cloudflare stamps every response that passes its edge with a
   * cf-ray header, which is what separates "the gate is doing its job" from
   * "this request never left the LAN and proves nothing".
   */
  async function checkEntrance(): Promise<Omit<Check, 'id' | 'label'>> {
    const url = env.PUBLIC_URL;
    const facts: Array<{ k: string; v: string }> = [{ k: 'Address', v: url }];

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(6_000),
        headers: { 'user-agent': 'GameKeepr self-check' },
      });
    } catch (err) {
      return {
        state: 'unknown',
        summary: 'Could not be reached from inside the container.',
        detail: `This says nothing about whether visitors can reach it -- only that this container could not. ${(err as Error).message}`,
        facts,
      };
    }

    const viaCloudflare = response.headers.has('cf-ray');
    const location = response.headers.get('location') ?? '';
    const gated = /\.cloudflareaccess\.com\//i.test(location);
    facts.push({ k: 'Answered', v: String(response.status) });
    facts.push({ k: 'Through Cloudflare', v: viaCloudflare ? 'yes' : 'no' });

    if (gated) {
      return {
        state: 'ok',
        summary: 'Anonymous visitors are stopped by Cloudflare Access.',
        detail: 'Two gates: Access first, then this portal’s own login.',
        secretHome:
          'The tunnel token lives on the cloudflared container, not here. Access policies live in Cloudflare Zero Trust.',
        facts,
      };
    }

    if (viaCloudflare) {
      return {
        state: 'warn',
        summary: 'Served through Cloudflare, but nothing stops an anonymous visitor.',
        detail:
          'This portal’s own login is the only barrier. That is not broken, but it is one layer fewer than intended -- add a Cloudflare Access policy in front of this hostname.',
        secretHome: 'Access policies live in Cloudflare Zero Trust.',
        facts,
      };
    }

    return {
      state: 'unknown',
      summary: 'The request never left the local network.',
      detail:
        'The address resolved to something inside the LAN, so this check cannot judge what the outside world sees. Test it from mobile data instead.',
      facts,
    };
  }

  // ---- the tunnel container ---------------------------------------------
  async function checkTunnel(
    containers: Array<{ Image: string; Names: string[]; State: string; Status: string }>,
  ): Promise<Omit<Check, 'id' | 'label'>> {
    const found = containers.find(
      (c) =>
        /cloudflare|cloudflared/i.test(c.Image) ||
        c.Names.some((n) => /cloudflared|tunnel/i.test(n)),
    );

    const home =
      'The tunnel token lives on that container (its own environment), never in GameKeepr. Rotate it in Zero Trust and recreate the container -- a restart does not re-read an env file.';

    if (!found) {
      return {
        state: 'off',
        summary: 'No tunnel container on this host.',
        detail:
          'Fine if you reach the portal another way, or only over the LAN. A tunnel is how you publish it without opening a port on your router.',
        facts: [],
      };
    }

    const name = found.Names[0]?.replace(/^\//, '') ?? 'unknown';
    const running = found.State === 'running';
    return {
      state: running ? 'ok' : 'bad',
      summary: running ? 'Running.' : 'Present but not running.',
      detail: running ? undefined : 'While it is down the portal is unreachable from outside.',
      secretHome: home,
      facts: [
        { k: 'Container', v: name },
        { k: 'Image', v: found.Image },
        { k: 'State', v: found.Status },
      ],
    };
  }

  // ---- the router connection --------------------------------------------
  async function checkRouter(): Promise<Omit<Check, 'id' | 'label'>> {
    const home =
      'Its API key is encrypted in this portal’s database with SESSION_SECRET. Rotate the key on the router, then re-enter it below.';
    const raw = db.getSetting('router');
    const lan = env.LAN_ADDRESS.trim();

    if (!raw) {
      return {
        state: 'off',
        summary: 'No router connected.',
        detail:
          'Optional. Without one the portal still lists the forwarding rules a new server needs, you just make them by hand.',
        facts: lan ? [{ k: 'Forwards would point at', v: lan }] : [],
      };
    }

    const plain = decryptSecret(raw, env.SESSION_SECRET);
    if (!plain) {
      return {
        state: 'bad',
        summary: 'A connection is stored but cannot be decrypted.',
        detail:
          'SESSION_SECRET changed since it was saved, so the stored key is unreadable. Re-enter the router credentials below to fix it.',
        secretHome: home,
        facts: [],
      };
    }

    let stored: { provider: string; config: Record<string, string> };
    try {
      stored = JSON.parse(plain);
    } catch {
      return {
        state: 'bad',
        summary: 'The stored connection is corrupt.',
        detail: 'Disconnect and connect again.',
        secretHome: home,
        facts: [],
      };
    }

    const provider = buildProvider(stored.provider, stored.config);
    if (!provider) {
      return {
        state: 'bad',
        summary: `Unknown router type "${stored.provider}".`,
        detail: 'This portal no longer supports that type. Reconnect with a supported one.',
        facts: [],
      };
    }

    const facts: Array<{ k: string; v: string }> = [{ k: 'Type', v: provider.label }];
    if (lan) facts.push({ k: 'Forwards point at', v: lan });

    try {
      const result = await provider.test();
      const rules = await provider.list();
      const mine = rules.filter((r) => r.managed).length;
      facts.push({ k: 'Rules on the router', v: String(result.rules) });
      facts.push({ k: 'Created by GameKeepr', v: String(mine) });

      return {
        state: lan ? 'ok' : 'warn',
        summary: lan ? `Connected — ${result.detail}` : 'Connected, but forwards have nowhere to point.',
        detail: lan
          ? undefined
          : 'Set LAN_ADDRESS in .env to this machine’s address, otherwise a forward has no destination.',
        secretHome: home,
        facts,
      };
    } catch (err) {
      return {
        state: 'bad',
        summary: 'Connected settings, but the router refused.',
        detail: `${(err as Error).message} The API key may have been revoked on the router.`,
        secretHome: home,
        facts,
      };
    }
  }

  // ---- secrets at rest ---------------------------------------------------
  async function checkEncryption(): Promise<Omit<Check, 'id' | 'label'>> {
    const length = env.SESSION_SECRET.length;
    // A secret that is merely long but repetitive is no secret at all.
    const distinct = new Set(env.SESSION_SECRET).size;
    const weak = distinct < 8;

    return {
      state: weak ? 'warn' : 'ok',
      summary: weak
        ? 'In use, but SESSION_SECRET looks predictable.'
        : 'Integration credentials are encrypted at rest.',
      detail: weak
        ? 'Replace it with the output of "openssl rand -hex 32". Note that changing it signs everyone out and makes a stored router key unreadable, so re-enter that afterwards.'
        : undefined,
      secretHome:
        'SESSION_SECRET lives in the .env file on this host. It is never in the database, so a stolen copy of the database alone reveals nothing.',
      facts: [{ k: 'Key length', v: `${length} characters` }],
    };
  }

  // ---- storage -----------------------------------------------------------
  async function checkDatabase(): Promise<Omit<Check, 'id' | 'label'>> {
    const info = await stat(env.DATABASE_PATH);
    const auditRows = (
      db.raw.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }
    ).n;
    const sessions = (
      db.raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').get(Date.now()) as {
        n: number;
      }
    ).n;

    return {
      state: 'ok',
      summary: 'Readable.',
      facts: [
        { k: 'File', v: env.DATABASE_PATH },
        { k: 'Size', v: bytes(info.size) },
        { k: 'Accounts', v: String(db.userCount()) },
        { k: 'Signed in now', v: String(sessions) },
        { k: 'Audit entries', v: String(auditRows) },
      ],
    };
  }

  // ---- host integration --------------------------------------------------
  async function checkUnraid(): Promise<Omit<Check, 'id' | 'label'>> {
    const dir = env.UNRAID_TEMPLATE_DIR;
    try {
      await access(dir, constants.W_OK);
      return {
        state: 'ok',
        summary: 'Templates are writable, so new servers appear in the Unraid UI.',
        facts: [{ k: 'Folder', v: dir }],
      };
    } catch {
      return {
        state: 'off',
        summary: 'Not mounted.',
        detail:
          'Only matters on Unraid. Without it a server deployed here still runs, it just does not get a tile in the Unraid dashboard.',
        facts: [{ k: 'Expected at', v: dir }],
      };
    }
  }

  // ---- what is actually being managed ------------------------------------
  async function checkServers(
    containers: Array<{ Names: string[]; State: string }>,
  ): Promise<Omit<Check, 'id' | 'label'>> {
    const list = registry.list();
    const running = list.filter((s) =>
      containers.some((c) => c.Names.some((n) => n.replace(/^\//, '') === s.container) && c.State === 'running'),
    ).length;

    return {
      state: list.length === 0 ? 'warn' : 'ok',
      summary:
        list.length === 0
          ? 'No game servers are configured yet.'
          : `${running} of ${list.length} running.`,
      facts: [
        { k: 'Configured in servers.json', v: String(list.length - db.listManagedServers().length) },
        { k: 'Deployed from this portal', v: String(db.listManagedServers().length) },
      ],
    };
  }

  async function build(): Promise<HealthReport> {
    // Fetched once and shared: two checks need the container list, and asking
    // Docker twice on a busy host is needless.
    let containers: Array<{ Image: string; Names: string[]; State: string; Status: string }> = [];
    try {
      containers = (await docker.docker.listContainers({ all: true })) as typeof containers;
    } catch {
      // The Docker check below will report the real problem.
    }

    const checks = await Promise.all([
      run('docker', 'Docker', checkDocker),
      run('entrance', 'Public entrance', checkEntrance),
      run('tunnel', 'Tunnel', () => checkTunnel(containers)),
      run('router', 'Router', checkRouter),
      run('encryption', 'Secrets at rest', checkEncryption),
      run('database', 'Database', checkDatabase),
      run('unraid', 'Unraid templates', checkUnraid),
      run('servers', 'Game servers', () => checkServers(containers)),
    ]);

    return { checkedAt: Date.now(), checks };
  }

  return {
    async report(force = false): Promise<HealthReport> {
      if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
      cached = await build();
      return cached;
    },
  };
}

export type HealthReporter = ReturnType<typeof createHealthReporter>;
