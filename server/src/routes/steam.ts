
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { DeployError, NAME_PATTERN, RESERVED_NAME_PREFIX, slugify } from '../deploy.js';
import { ModSourceError } from '../mods/sources.js';
import { inspectSteamApp, proposeCommand } from '../steam/appinfo.js';
import { buildSteamPlan, writeSteamScaffold, STEAM_IMAGE } from '../steam/compose.js';
import { notifyServer } from '../notify.js';
import { identifyGame } from '../games.js';
import { passes, uncertain, type Finding } from '../findings.js';
import { reviewSteamAnonymous, steamPreflight } from '../review/preflight.js';
import { autoForward } from '../router/stored.js';

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
  const { registry, db, env, guard, deployer, steam, notify, gameQuery, artwork } = ctx;
  const operator = { preHandler: guard.requireOperator };

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

    // A pasted id or URL skips the catalogue entirely.
    const pastedId = q ? parseAppReference(q) : null;
    if (pastedId) {
      return reply.send({ ...status, results: [], appId: pastedId });
    }

    // An empty query returns the whole catalogue, exactly like the Unraid
    // tab: the list is for browsing, the search box only narrows it.
    return reply.send({ ...status, results: await steam.search(q), appId: null });
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

        /*
         * Steam shrugging is not the end of the line. The registry knows the
         * real start script for several servers whose app info lists no Linux
         * launch entry (7 Days to Die, Project Zomboid); and for the rest, an
         * empty command now means the generated start script goes looking for
         * the server's own conventional script on first boot.
         */
        let command = proposal.command;
        let warnings = proposal.warnings;
        if (!command && info.linux && known?.serverLaunch) {
          command = known.serverLaunch;
          warnings = warnings
            .filter((w) => !w.includes('written by hand'))
            .concat(
              `Steam lists no Linux launch command for this app, but GameKeepr knows ${known.label}: the server's own start script is prefilled.`,
            );
        } else if (!command && info.linux) {
          warnings = warnings
            .filter((w) => !w.includes('written by hand'))
            .concat(
              'Steam lists no Linux launch command for this app. Leave the field empty and GameKeepr will look for the server’s own start script (startserver.sh and friends) on first boot — or write the command by hand if you know it.',
            );
        }

        return reply.send({
          info,
          command,
          warnings,
          image: STEAM_IMAGE,
          known: known ? { label: known.label } : null,
          // Prefilled from the registry when the game is recognised; the
          // operator edits or extends the list either way.
          ports: (known?.ports ?? [])
            .filter((p) => p.required)
            .map((p) => ({ container: p.port, host: p.port, protocol: p.protocol, purpose: p.purpose })),
          // Shown in the form, before deploy: whether the download will want
          // an account. The deploy gate holds the same judgement.
          login: reviewSteamAnonymous(appId, false),
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
      acknowledge?: boolean;
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
    if (name.toLowerCase().startsWith(RESERVED_NAME_PREFIX)) {
      return reply.code(400).send({
        error: 'reserved-name',
        message: `Names starting with "${RESERVED_NAME_PREFIX}" belong to validation runs, which delete them with their data.`,
      });
    }
    const serverId = slugify(name);
    if (registry.get(serverId)) {
      return reply.code(409).send({ error: 'id-taken', message: `"${serverId}" already exists.` });
    }

    // Empty is allowed on purpose: the generated start script then finds the
    // server's own conventional start script on first boot, or refuses loudly.
    const command = String(body.command ?? '').trim();
    if (command.length > 300 || /[\r\n\0]/.test(command)) {
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

      /*
       * The Steam path's preflight, in the same Finding language as the
       * catalogue path: a fail refuses, a warn or unknown proceeds only once
       * acknowledged. Shared with the validation runner, so a validation's
       * "refused" is a deploy's refusal by construction.
       */
      const findings = steamPreflight(info, Boolean(String(body.steamUsername ?? '').trim()));

      if (!passes(findings)) {
        db.audit({
          userId: user.id, username: user.username, serverId,
          action: 'server-deployed', result: 'failure',
          detail: `Refused ${info.name}: ${findings.filter((f) => f.state === 'fail').map((f) => f.summary).join('; ')}`,
          ...originOf(request),
        });
        return reply.code(422).send({ error: 'refused', findings });
      }
      if (uncertain(findings) && !body.acknowledge) {
        return reply.code(428).send({ error: 'needs-acknowledgement', findings });
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

      // The script and the compose twin go in before the container exists, so
      // the very first start already runs the reviewed script — one writer,
      // shared with the validation runner.
      await writeSteamScaffold(plan, composeReq, env.APPDATA_HOST_ROOT);
      steps.push('Wrote gamekeep-start.sh and docker-compose.yml into the steamcmd volume');

      await deployer.ensureNetwork(env.GAME_NETWORK, (m) => steps.push(m));
      await deployer.create(plan, (m) => steps.push(m));

      const definition = {
        id: serverId,
        displayName: name,
        container: plan.containerName,
        /*
         * For the artwork. A dedicated-server app is usually a tool with a
         * grey placeholder for art (Soulmask's server is app 3017300; the
         * game is 2646460), so a recognised game's own id wins. The deploy's
         * id is the fallback that keeps an unrecognised server off the
         * lettered tile: every Steam app has at least a header image.
         */
        steamAppId: game?.steamAppId ?? appId,
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

      // Same as the catalogue path: fetch the poster now, or the card shows a
      // letter until the next portal restart.
      void artwork
        .ensure(registry.list(), (message) => request.log.info(message))
        .catch(() => undefined);

      // Same as the catalogue path: the deploy decided the ports, so a
      // connected router opens them now instead of after a forgotten click.
      const forwarded = registry.get(serverId);
      if (forwarded) {
        for (const message of await autoForward({ db, env, docker: ctx.docker }, forwarded, {
          userId: user.id,
          username: user.username,
        })) {
          steps.push(message);
        }
      }

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

      // The 201 says "created", never "works": the watch follows the first
      // boot (download heartbeat included — a Steam first boot IS a download)
      // and reports the honest outcome. No typed server name on this path, so
      // the name cross-check simply does not apply.
      const watch = server ? ctx.deployWatch.start(server, null) : null;

      return reply
        .code(201)
        .send({ serverId, steps, appdataPath: plan.appdataHostPath, watchId: watch?.id ?? null });
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
