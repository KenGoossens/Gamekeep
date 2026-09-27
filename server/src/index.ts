import { existsSync } from 'node:fs';
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
import { createHelperRunner } from './docker/helper.js';
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
import { registerDashboardRoutes } from './routes/dashboard.js';
import type { AppContext } from './context.js';

const here = dirname(fileURLToPath(import.meta.url));
// Resolves to <repo>/web/dist from both src (tsx dev) and dist (built).
const WEB_ROOT = resolve(here, '../../web/dist');

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
  const mods = createModInstaller(docker);
  const health = createHealthReporter({ env, db, docker, registry });
  const sessions = createSessions(env, db);
  const setup = createSetupGuard(db);
  const throttle = createLoginThrottle();
  const guard = createGuard(sessions);

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
    mods,
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
    return reply.code(dockerOk ? 200 : 503).send({ ok: dockerOk, servers: registry.list().length });
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
  registerDashboardRoutes(app, ctx);

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
   Gamekeep has no accounts yet. Open it and create the first admin.

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
    { servers: registry.list().map((s) => s.id), users: db.userCount() },
    'Gamekeep ready',
  );
}

main().catch((err) => {
  console.error('[Gamekeep] Fatal startup error:', err);
  process.exit(1);
});
