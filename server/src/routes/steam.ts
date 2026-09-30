import { mkdir, writeFile, chown } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { DeployError, NAME_PATTERN, slugify } from '../deploy.js';
import { ModSourceError } from '../mods/sources.js';
import { inspectSteamApp, proposeCommand } from '../steam/appinfo.js';
import { buildComposeFile, buildStartScript, buildSteamPlan, STEAM_IMAGE } from '../steam/compose.js';
import { notifyServer } from '../notify.js';
import { identifyGame } from '../games.js';

/**
 * Deploying any dedicated server Steam carries, from a container the portal
 * composes itself.
 *
 * The template path trusts a template author; this path trusts exactly two
 * parties -- Valve's official steamcmd image and Steam's own depots -- and
 * shows the operator the one thing in between: the generated start script,
 * which also lands in the server's own volume where the Files tab can read
 * it. Nothing here can ever be privileged, because the portal writes the
 * container definition itself.
 */
export function registerSteamRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, db, env, guard, deployer, steam, notify, gameQuery } = ctx;
  const operator = { preHandler: guard.requireOperator };
  const owner = { preHandler: guard.requireOwner };

  /** Accepts an app id, a store URL or a steamdb URL; people paste all three. */
  function parseAppReference(raw: string): number | null {
    const text = raw.trim();
    if (/^\d{1,8}$/.test(text)) return Number(text);
    const match = /(?:store\.steampowered\.com|steamdb\.info)\/app\/(\d{1,8})/i.exec(text);
    return match ? Number(match[1]) : null;
  }

  app.get<{ Querystring: { q?: string } }>('/api/steam/search', operator, async (request, reply) => {
    const q = String(request.query.q ?? '').trim();
    const status = steam.status();

    // A pasted id or URL skips the catalogue entirely; that route never
    // depends on a key or a cache.
    const pastedId = q ? parseAppReference(q) : null;
    if (pastedId) {
      return reply.send({ ...status, results: [], appId: pastedId, stale: false });
    }

    if (q.length < 2) return reply.send({ ...status, results: [], appId: null, stale: false });
    const { results, stale } = await steam.search(q);
    return reply.send({ ...status, results, appId: null, stale });
  });

  app.get('/api/steam/integration', owner, async (_request, reply) => reply.send(steam.status()));

  app.put<{ Body: { webApiKey?: string } }>(
    '/api/steam/integration',
    owner,
    async (request, reply) => {
      const key = String(request.body?.webApiKey ?? '').trim();
      if (!/^[A-F0-9]{32}$/i.test(key)) {
        return reply.code(400).send({
          error: 'bad-key',
          message: 'A Steam Web API key is 32 hex characters — get one free at steamcommunity.com/dev/apikey.',
        });
      }
      steam.setApiKey(key);
      db.audit({
        userId: request.user!.id,
        username: request.user!.username,
        serverId: null,
        action: 'integration-changed',
        result: 'success',
        detail: 'Steam Web API key set',
        ...originOf(request),
      });
      return reply.send(steam.status());
    },
  );

  app.post('/api/steam/catalog/refresh', owner, async (request, reply) => {
    try {
      const count = await steam.refresh();
      return reply.send({ count, ...steam.status() });
    } catch (err) {
      return reply.code(502).send({ error: 'refresh-failed', message: (err as Error).message });
    }
  });

  /** Everything needed to decide: what it is, whether it runs here, and how. */
  app.get<{ Params: { appId: string } }>(
    '/api/steam/app/:appId',
    operator,
    async (request, reply) => {
      const appId = parseAppReference(request.params.appId);
      if (!appId) return reply.code(400).send({ error: 'bad-app-id' });

      try {
        const info = await inspectSteamApp(appId);
        const proposal = proposeCommand(info);
        const known = identifyGame(info.name, '');
        return reply.send({
          info,
          command: proposal.command,
          warnings: proposal.warnings,
          image: STEAM_IMAGE,
          known: known ? { label: known.label } : null,
          // Prefilled from the registry when the game is recognised; the
          // operator edits or extends the list either way.
          ports: (known?.ports ?? [])
            .filter((p) => p.required)
            .map((p) => ({ container: p.port, host: p.port, protocol: p.protocol, purpose: p.purpose })),
        });
      } catch (err) {
        if (err instanceof ModSourceError) {
          const code = err.code === 'not-found' ? 404 : err.code === 'bad-reference' ? 400 : 502;
          return reply.code(code).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{
    Body: {
      appId?: number;
      name?: string;
      command?: string;
      ports?: Array<{ container?: number; host?: number; protocol?: string }>;
      gameParams?: string;
      validate?: boolean;
      steamUsername?: string;
      steamPassword?: string;
    };
  }>('/api/steam/deploy', operator, async (request, reply) => {
    const user = request.user!;
    const body = request.body ?? {};

    const appId = Number(body.appId);
    if (!Number.isInteger(appId) || appId <= 0) {
      return reply.code(400).send({ error: 'bad-app-id' });
    }
    const name = String(body.name ?? '').trim();
    if (!NAME_PATTERN.test(name)) {
      return reply.code(400).send({
        error: 'invalid-name',
        message: 'Name must be 2-32 characters: letters, digits, and . _ - (starting with a letter or digit).',
      });
    }
    const serverId = slugify(name);
    if (registry.get(serverId)) {
      return reply.code(409).send({ error: 'id-taken', message: `"${serverId}" already exists.` });
    }

    const command = String(body.command ?? '').trim();
    if (!command || command.length > 300 || /[\r\n\0]/.test(command)) {
      return reply.code(400).send({
        error: 'bad-command',
        message: 'The start command must be one line of at most 300 characters.',
      });
    }

    const ports: Array<{ container: number; host: number; protocol: 'tcp' | 'udp' }> = [];
    for (const raw of body.ports ?? []) {
      const container = Number(raw.container);
      const host = Number(raw.host ?? raw.container);
      if (![container, host].every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
        return reply.code(400).send({ error: 'bad-port', message: `${raw.container} is not a usable port.` });
      }
      ports.push({ container, host, protocol: raw.protocol === 'udp' ? 'udp' : 'tcp' });
    }

    try {
      // The app is inspected again server-side: the name in the script header
      // and the Linux check must come from Steam, not from the client.
      const info = await inspectSteamApp(appId);
      if (!info.linux) {
        return reply.code(422).send({
          error: 'no-linux',
          message: `Steam publishes no Linux build of ${info.name}, so it cannot run here. The Unraid catalogue may have a Wine-based template for it.`,
        });
      }

      const composeReq = {
        appId,
        appName: info.name,
        name,
        command,
        ports,
        gameParams: String(body.gameParams ?? '').replace(/[\r\n]/g, ' ').slice(0, 300),
        validate: body.validate === true,
        steamUsername: String(body.steamUsername ?? '').trim() || undefined,
        steamPassword: String(body.steamPassword ?? '') || undefined,
      };
      const { plan, game } = buildSteamPlan(composeReq, env.APPDATA_ROOT, env.APPDATA_HOST_ROOT, env.GAME_NETWORK);

      const steps: string[] = [];
      for (const added of plan.addedPorts) {
        steps.push(`Added ${added}, which ${info.name} needs and the request omitted`);
      }

      /*
       * The script and the compose file go in before the container exists, so
       * the very first start already runs the reviewed script -- and both
       * live inside the volume, where the Files tab shows them.
       */
      const scriptDir = join(plan.appdataPath, 'steamcmd');
      await mkdir(scriptDir, { recursive: true });
      await writeFile(join(scriptDir, 'gamekeep-start.sh'), buildStartScript(composeReq), {
        mode: 0o755,
      });
      await writeFile(
        join(scriptDir, 'docker-compose.yml'),
        buildComposeFile(composeReq, env.APPDATA_HOST_ROOT),
      );
      await chown(scriptDir, 99, 100).catch(() => undefined);
      steps.push('Wrote gamekeep-start.sh and docker-compose.yml into the steamcmd volume');

      await deployer.ensureNetwork(env.GAME_NETWORK, (m) => steps.push(m));
      await deployer.create(plan, (m) => steps.push(m));

      const definition = {
        id: serverId,
        displayName: name,
        container: plan.containerName,
        cooldownSeconds: 300,
        query:
          game && ports.length > 0
            ? { type: game.query, host: plan.containerName, port: Math.min(...ports.map((p) => p.container)) }
            : undefined,
        notes: `Deployed from Steam (app ${appId}, ${info.name}).`,
      };
      db.addManagedServer(serverId, definition, user.id);
      registry.reload();
      gameQuery.invalidate(serverId);

      db.audit({
        userId: user.id,
        username: user.username,
        serverId,
        action: 'server-deployed',
        result: 'success',
        detail: `Composed ${info.name} (Steam app ${appId}, ${STEAM_IMAGE}) as ${name}; start: ${command}`,
        ...originOf(request),
      });
      const server = registry.get(serverId);
      notify.send({
        kind: 'deployed',
        server: server ? notifyServer(server) : { name },
        actor: { username: user.username, role: user.role },
        detail: `${info.name} — composed from Steam, downloading on first start`,
      });

      return reply.code(201).send({ serverId, steps, appdataPath: plan.appdataHostPath });
    } catch (err) {
      if (err instanceof DeployError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      if (err instanceof ModSourceError) {
        const code = err.code === 'not-found' ? 404 : 502;
        return reply.code(code).send({ error: err.code, message: err.message });
      }
      db.audit({
        userId: user.id,
        username: user.username,
        serverId,
        action: 'server-deployed',
        result: 'failure',
        detail: (err as Error).message,
        ...originOf(request),
      });
      return reply.code(500).send({ error: 'deploy-failed', message: (err as Error).message });
    }
  });
}
