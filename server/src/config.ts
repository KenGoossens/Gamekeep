import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * All configuration is validated at boot and the process exits non-zero on any
 * problem. This is deliberate: the servers file IS the container whitelist, so
 * booting with it silently empty or malformed would be a security failure
 * rather than a degraded mode.
 */

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: z.string().url('PUBLIC_URL must be a full URL, e.g. https://gm.example.com'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)'),
  DATABASE_PATH: z.string().min(1).default('/data/gamekeep.db'),
  /**
   * Where world backups are written. Inside the portal's own data volume by
   * default, so they survive the game server being recreated -- the whole
   * point -- and are covered by whatever backs up appdata itself.
   */
  BACKUP_DIR: z.string().min(1).default('/data/backups'),
  CONFIG_PATH: z.string().min(1).default('/config/servers.json'),
  DOCKER_SOCKET_PATH: z.string().min(1).default('/var/run/docker.sock'),
  DOCKER_HOST: z.string().url().optional(),
  /**
   * Two views of the same directory, and they must not be confused.
   *
   * APPDATA_ROOT is where the portal container sees appdata, used to create
   * the folders. APPDATA_HOST_ROOT is that same directory's path on the Unraid
   * host, and it is what goes into a bind mount -- Docker resolves binds
   * against the host, so using the container path silently writes game data to
   * the host root filesystem, which on Unraid is RAM.
   */
  APPDATA_ROOT: z.string().min(1).default('/appdata'),
  APPDATA_HOST_ROOT: z.string().min(1).default('/srv/gameservers'),
  /**
   * The Unraid host's address on the LAN. Port forwards point here, because
   * the router forwards to the machine, not to a container.
   */
  LAN_ADDRESS: z.string().default(''),
  /**
   * Where Unraid keeps its container templates. Writing one makes a deployed
   * server show up properly in the Unraid UI; on any other host this stays
   * unmounted and the step is simply skipped.
   */
  UNRAID_TEMPLATE_DIR: z.string().default('/unraid-templates'),
  /**
   * The Docker network deployed game servers join, created and joined by the
   * portal if it does not exist.
   *
   * Not the default bridge, where containers cannot resolve each other by
   * name -- which is why a deployed server had to be queried through the
   * host's own address instead of directly. And not, by default, whatever
   * network the portal itself is on: Docker isolates bridge networks from one
   * another, so a separate one keeps a game server -- which runs third-party
   * mod code -- away from a tunnel or reverse proxy sitting beside the portal.
   * Set it to the portal's own network to keep everything together instead.
   */
  GAME_NETWORK: z.string().min(1).default('gamekeep-servers'),
  /**
   * Publishers allowed to be deployed from Community Applications. Deploying a
   * container is root-equivalent on the host, so this is a trust list, not a
   * convenience filter. Comma-separated; leave unset for the built-in default.
   */
  TRUSTED_PUBLISHERS: z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /**
   * Which sources may set X-Forwarded-For, as comma-separated CIDRs.
   *
   * This decides what request.ip means, and therefore what the audit log
   * records. Trusting everyone (Fastify's trustProxy: true) lets any client
   * claim any address, including a LAN one -- so the default trusts only the
   * Docker bridge range, where a reverse proxy or cloudflared would sit, plus
   * loopback. A client reaching the portal directly can no longer forge it.
   */
  TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1,::1,172.16.0.0/12')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  NODE_ENV: z.enum(['development', 'production']).default('production'),
  /** Vite dev server origin, allowed through CORS only when NODE_ENV=development. */
  DEV_ORIGIN: z.string().url().default('http://localhost:5173'),
});

const querySchema = z.object({
  /** A GameDig game id: valheim, palworld, minecraft, arkse, rust, ... */
  type: z.string().min(1),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
});

export const serverSchema = z.object({
  /**
   * Public identifier used in URLs. Clients only ever name this -- never a
   * container -- so the character class is kept deliberately tight.
   */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'id must be lowercase letters, digits, "-" or "_" (max 32)'),
  displayName: z.string().min(1),
  /** Exact Docker container name on the host. Never accepted from a request. */
  container: z.string().min(1),
  query: querySchema.optional(),
  /**
   * Steam application id, used once to fetch that game's official artwork.
   * Omit it for anything not on Steam and the UI draws a lettered tile.
   */
  steamAppId: z.number().int().positive().optional(),
  /**
   * A server the tournament machinery runs: visible while it lives, gone at
   * teardown, and its lifecycle is the orchestrator's alone — restart, stop,
   * rename, delete and the standing-server tabs are all refused for it.
   */
  transient: z.boolean().optional(),
  /** Serve another entry's cached artwork instead of fetching per id — match
   * servers share their game's poster rather than refetching it per match. */
  artworkId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).optional(),
  /**
   * Artwork for a game that is not on Steam. Leave it out and the portal tries
   * the dashboard-icons set using this server's id as the slug, which already
   * covers most games; set it explicitly when that guess is wrong.
   */
  iconUrl: z.string().url().optional(),
  /** Optional accent colour (#rrggbb) for the tile background and card glow. */
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'accent must be a hex colour such as #c8a15a')
    .optional(),
  updateStrategy: z.enum(['restart', 'pull-recreate']).default('restart'),
  cooldownSeconds: z.number().int().min(0).max(86400).default(300),
  /*
   * How long a restart may take before it is reported as unconfirmed.
   *
   * Optional, and left unset for almost every server: the real value comes
   * from the game registry, which knows that ARK reinstalls its Workshop mods
   * on every start and that Factorio does not. This used to be copied into
   * each server at deploy time, which froze whatever the registry said that
   * day -- Project Zomboid kept reporting healthy restarts as unconfirmed
   * because its record still held the old fallback of 300s. Set this only to
   * override the registry for one particular server.
   *
   * It is a deadline, not a wait: the verifier polls every two seconds and
   * returns the moment the game answers.
   */
  restartTimeoutSeconds: z.number().int().min(10).max(2400).optional(),
  notes: z.string().optional(),
});

const serversFileSchema = z.object({
  /*
   * An empty list used to be refused, from the days when servers.json was the
   * only way a server could exist. The portal deploys servers itself now, so
   * a fresh install legitimately starts with none -- refusing to boot was
   * telling new users to hand-write the very file the catalogue replaces.
   */
  servers: z
    .array(serverSchema)
    .superRefine((servers, ctx) => {
      const seen = new Set<string>();
      for (const s of servers) {
        if (seen.has(s.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate server id "${s.id}".` });
        }
        seen.add(s.id);
      }
    }),
});

export type ServerConfig = z.infer<typeof serverSchema>;
export type Env = z.infer<typeof envSchema>;

function fail(what: string, detail: string): never {
  console.error(`\n[GameKeepr] Refusing to start -- ${what}:\n${detail}\n`);
  process.exit(1);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) fail('invalid environment', formatIssues(parsed.error));
  return parsed.data;
}

export function loadServers(configPath: string): ServerConfig[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    /*
     * A missing file is a fresh install, not a broken one: Community
     * Applications creates the mount but nothing puts a servers.json there,
     * and the portal deploys its own servers anyway. Any other read error --
     * permissions, a directory in the way -- still refuses to start, because
     * that is a real problem pretending to be an empty list.
     */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(
        `[GameKeepr] No server list at ${configPath} -- starting with none. ` +
          'Deploy servers from the portal, or list hand-managed containers in servers.json.',
      );
      return [];
    }
    return fail(
      `could not read the server list at ${configPath}`,
      `${(err as Error).message}\nCopy config/servers.example.json and edit it.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return fail(`${configPath} is not valid JSON`, (err as Error).message);
  }

  const parsed = serversFileSchema.safeParse(json);
  if (!parsed.success) fail(`${configPath} is invalid`, formatIssues(parsed.error));
  return parsed.data.servers;
}

