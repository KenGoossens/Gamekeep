import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { loadEnv, loadServers } from './config.js';
import { createServerRegistry } from './registry.js';
import { openDatabase } from './db.js';
import { createDockerClient } from './docker/client.js';
import { createActionRunner } from './docker/actions.js';
import { createGameQuery } from './query/gamedig.js';
import { createCooldown } from './cooldown.js';
import { createArtworkStore } from './artwork.js';
import { createCatalog, DEFAULT_TRUSTED_PUBLISHERS } from './catalog.js';
import { createDeployer } from './deploy.js';
import { createMetricsCollector } from './metrics.js';
import { createSettingsManager } from './settings.js';
import { createFileBrowser } from './files.js';
import { createHealthReporter } from './health.js';
import { createModInstaller } from './mods/install.js';
import { createWorkshopDeclarations } from './mods/declare.js';
import { createScheduler } from './schedule.js';
import { createBackupService } from './backup.js';
import { createSteamCatalog } from './steam/catalog.js';
import { createGsltService } from './steam/gslt.js';
import { createTournamentStore } from './tournaments/store.js';
import { createMatchOrchestrator } from './tournaments/orchestrator.js';
import { createHelperRunner } from './docker/helper.js';
import { createNotifier } from './notify.js';
import { createWatcher } from './watch.js';
import { createSessions } from './auth/session.js';
import { createSetupGuard } from './auth/setup.js';
import { createLoginThrottle } from './auth/ratelimit.js';
import { createGuard } from './auth/guard.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerServerRoutes } from './routes/servers.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerUserRoutes } from './routes/users.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerArtworkRoutes } from './routes/artwork.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerManageRoutes } from './routes/manage.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerModRoutes } from './routes/mods.js';
import { registerWorkshopRoutes } from './routes/workshop.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerSteamRoutes } from './routes/steam.js';
import { registerWikiRoutes } from './routes/wiki.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerAccessRoutes } from './routes/access.js';
import { registerNotifyRoutes, readNotifyConfig } from './routes/notify.js';
import { registerGsltRoutes } from './routes/gslt.js';
import { registerTournamentRoutes } from './routes/tournaments.js';
import type { AppContext } from './context.js';

const here = dirname(fileURLToPath(import.meta.url));
// Resolves to <repo>/web/dist from both src (tsx dev) and dist (built).
const WEB_ROOT = resolve(here, '../../web/dist');

/** From package.json, so the version people report matches the changelog. */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

async function main() {
  const env = loadEnv();
  const servers = loadServers(env.CONFIG_PATH);
  const db = openDatabase(env.DATABASE_PATH);
  const registry = createServerRegistry(servers, db);

  const docker = createDockerClient(env);
  const gameQuery = createGameQuery();
  const actions = createActionRunner(docker, gameQuery);
  const cooldown = createCooldown(db);
  const artwork = createArtworkStore(env.DATABASE_PATH);
  const catalog = createCatalog(
    env.DATABASE_PATH,
    env.TRUSTED_PUBLISHERS.length > 0 ? env.TRUSTED_PUBLISHERS : DEFAULT_TRUSTED_PUBLISHERS,
  );
  const deployer = createDeployer(docker);
  const metrics = createMetricsCollector(docker, registry, gameQuery, db);
  const settings = createSettingsManager(docker);
  const files = createFileBrowser(docker);
  const notify = createNotifier({
    publicUrl: env.PUBLIC_URL,
    readConfig: () => readNotifyConfig({ db, env }),
    // Console rather than app.log: the services are built before Fastify is,
    // and a failed notification is not worth reordering the boot for.
    onError: (message) => console.warn(`[GameKeepr] ${message}`),
  });
  const mods = createModInstaller(docker);
  const workshop = createWorkshopDeclarations(docker);
  const backups = createBackupService({ docker, db, backupDir: env.BACKUP_DIR });
  const steam = createSteamCatalog();
  const gslt = createGsltService(db, env);
  const tournaments = createTournamentStore(db.raw);
  const matches = createMatchOrchestrator({
    store: tournaments,
    deployer,
    docker,
    gslt,
    db,
    env,
    notify,
    log: (message) => console.log(`[GameKeepr] ${message}`),
  });
  const scheduler = createScheduler({
    db,
    registry,
    actions,
    docker,
    gameQuery,
    // Console for the same reason the notifier uses it: built before Fastify.
    log: (message) => console.log(`[GameKeepr] ${message}`),
  });
  // A scheduled backup runs exactly like a manual one; only the actor differs.
  scheduler.setBackupRunner(async (server, actor) =>
    backups.describe(await backups.make(server, { actor, kind: 'scheduled' })),
  );
  const health = createHealthReporter({ env, db, docker, registry });
  const sessions = createSessions(env, db);
  const setup = createSetupGuard(db);
  const throttle = createLoginThrottle();
  const guard = createGuard(sessions, db);

  const ctx: AppContext = {
    env,
    registry,
    db,
    docker,
    actions,
    gameQuery,
    cooldown,
    artwork,
    catalog,
    deployer,
    metrics,
    settings,
    files,
    notify,
    mods,
    workshop,
    scheduler,
    backups,
    steam,
    gslt,
    tournaments,
    matches,
    health,
    sessions,
    setup,
    throttle,
    guard,
  };

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
      // Cloudflare Tunnel fronts the app, so the client IP arrives in a header.
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
    // Not "true": that would trust an X-Forwarded-For from anyone, which
    // makes both the audit log and any address-based rule forgeable.
    trustProxy: env.TRUSTED_PROXIES,
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  // Uploads into a game server’s own directory; capped well below anything
  // that would fill the array by accident.
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

  // Several POSTs here take no parameters (logout, restart, reset-password).
  // Fastify's default JSON parser rejects an empty body before any preHandler
  // runs, which turns "not allowed" into a confusing 400. Treat empty as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (raw.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }), undefined);
    }
  });

  if (env.NODE_ENV === 'development') {
    // Only in dev, so the Vite server on :5173 can reach the API with cookies.
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin === env.DEV_ORIGIN) {
        reply.header('access-control-allow-origin', origin);
        reply.header('access-control-allow-credentials', 'true');
        reply.header('access-control-allow-headers', 'content-type');
        reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
      }
      if (request.method === 'OPTIONS') return reply.code(204).send();
    });
  }

  app.get('/api/health', async (_request, reply) => {
    const dockerOk = await docker.ping();
    return reply
      .code(dockerOk ? 200 : 503)
      .send({ ok: dockerOk, version: VERSION, servers: registry.list().length });
  });

  registerAuthRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerArtworkRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerManageRoutes(app, ctx);
  registerNetworkRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerModRoutes(app, ctx);
  registerWorkshopRoutes(app, ctx);
  registerScheduleRoutes(app, ctx);
  registerBackupRoutes(app, ctx);
  registerConsoleRoutes(app, ctx);
  registerSteamRoutes(app, ctx);
  registerWikiRoutes(app, ctx);
  registerDashboardRoutes(app, ctx);
  registerLogRoutes(app, ctx);
  registerAccessRoutes(app, ctx);
  registerNotifyRoutes(app, ctx);
  registerGsltRoutes(app, ctx);
  registerTournamentRoutes(app, ctx);

  if (existsSync(join(WEB_ROOT, 'index.html'))) {
    await app.register(fastifyStatic, { root: WEB_ROOT });
    // SPA fallback: anything that is not an API or auth route serves the app
    // shell, so a deep link or a refresh does not 404.
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/auth/') &&
        !request.url.startsWith('/artwork/')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not-found' });
    });
  } else {
    app.log.warn(
      { WEB_ROOT },
      'No built frontend found. Run "npm run build" in web/, or use the Vite dev server.',
    );
  }

  // Helpers left behind by a previous life of this process: see helper.ts.
  void createHelperRunner(docker)
    .sweepOrphans()
    .then((n) => {
      if (n > 0) app.log.warn({ removed: n }, 'removed orphaned helper containers');
    });

  sessions.startSweeper();
  metrics.start();
  scheduler.start();
  matches.start();
  createWatcher({
    registry,
    docker,
    actions,
    notify,
    lastActionAt: (id) => db.lastServerActionAt(id),
  }).start();

  // Fetched in the background: a slow or blocked Steam CDN must not hold up
  // the portal, and a missing image only costs a lettered tile.
  void artwork
    .ensure(registry.list(), (message) => app.log.info(message))
    .catch((err) => app.log.warn({ err }, 'artwork fetch failed'));

  // Printed to the container log, never written to disk: creating the first
  // administrator requires access to the server's logs, not merely the URL.
  const setupToken = setup.begin();
  if (setupToken) {
    app.log.warn(`
  ==================================================================
   GameKeepr has no accounts yet. Open it and create the first admin.

   SETUP TOKEN: ${setupToken}

   This token is required to create that first account. It is valid
   until this container restarts, and a new one is printed each boot.
  ==================================================================`);
  }

  if (!(await docker.ping())) {
    app.log.error(
      env.DOCKER_HOST
        ? `Cannot reach Docker at ${env.DOCKER_HOST}.`
        : `Cannot reach the Docker socket at ${env.DOCKER_SOCKET_PATH}. Is it mounted into this container?`,
    );
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.raw.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(
    { version: VERSION, servers: registry.list().map((s) => s.id), users: db.userCount() },
    'GameKeepr ready',
  );
}

main().catch((err) => {
  console.error('[GameKeepr] Fatal startup error:', err);
  process.exit(1);
});
