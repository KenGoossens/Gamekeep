import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { ServerConfig } from '../config.js';
import { originOf } from '../auth/origin.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { dataRootsOf } from '../files.js';
import { getSource, sourceForGame, ModSourceError, type ModSource } from '../mods/sources.js';
import { layoutFor, type InstalledState } from '../mods/install.js';
import { gameByQueryType } from '../games.js';
import type { ScannerConfig } from '../mods/scan.js';
import '../mods/ficsit.js';
import '../mods/thunderstore.js';
import '../mods/modrinth.js';

/**
 * Installing a mod is running someone else's code inside a game server on this
 * host, so it sits at operator level and never below it: a member may restart
 * a server, which is self-healing, but may not change what it runs.
 *
 * It is also only allowed while the server is stopped -- the same rule the
 * files and settings tabs follow, for the same reason: changing what a running
 * process has already loaded produces a state nobody can reason about.
 */

const SCANNER_KEY = 'scanners';

export function registerModRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, db, env, guard, mods, notify } = ctx;
  const operator = { preHandler: guard.requireOperator };
  const owner = { preHandler: guard.requireOwner };

  function scannerConfig(): ScannerConfig {
    const raw = db.getSetting(SCANNER_KEY);
    if (!raw) return {};
    const plain = decryptSecret(raw, env.SESSION_SECRET);
    if (!plain) return {};
    try {
      return JSON.parse(plain) as ScannerConfig;
    } catch {
      return {};
    }
  }

  /** The server, its mod source and its layout, or a reason there is none. */
  async function context(id: string) {
    const server = registry.get(id);
    if (!server) return { ok: false as const, error: { code: 404, body: { error: 'unknown-server' } } };

    const gameType = server.query?.type;
    const source = sourceForGame(gameType);
    const layout = layoutFor(gameType);
    if (!source || !layout) {
      return {
        ok: false as const,
        error: {
          code: 400,
          body: {
            error: 'unsupported-game',
            // Some games have mods but no repository worth automating, and
            // saying which is more use than a flat refusal.
            message:
              gameByQueryType(gameType)?.modsUnavailable ??
              (gameByQueryType(gameType)
                ? `Gamekeep has no mod repository for ${gameByQueryType(gameType)!.label} yet.`
                : gameType
                  ? `Gamekeep does not recognise "${gameType}" as a game it can find mods for.`
                  : 'This server has no game type set, so Gamekeep cannot tell which mods would fit.'),
          },
        },
      };
    }
    return { ok: true as const, server, source, layout };
  }

  /**
   * Where this server keeps its game files; mods are placed relative to it.
   * These images mount the game under .../serverfiles and SteamCMD itself
   * beside it, and a mod dropped into the SteamCMD tree would simply be
   * overwritten on the next update.
   */
  async function dataRoot(server: ServerConfig): Promise<string> {
    const roots = await dataRootsOf(docker, server);
    return roots.find((r) => r.endsWith('serverfiles')) ?? roots[0]!;
  }

  async function installedState(server: ServerConfig, source: ModSource): Promise<InstalledState> {
    const versions: Record<string, string> = {};
    for (const row of db.listInstalledMods(server.id)) versions[row.modId] = row.version;

    const layout = layoutFor(server.query?.type);
    let loaderPresent = false;

    if (source.loader) {
      // Disk is the authority, not our own records: the loader may well have
      // been put there by hand long before this portal existed.
      if (layout) {
        const root = await dataRoot(server);
        for (const marker of layout.loaderMarkers) {
          if (await mods.exists(server.container, `${root}/${marker}`)) {
            loaderPresent = true;
            break;
          }
        }
      }
      if (!loaderPresent && versions[source.loader.id]) loaderPresent = true;
    }
    return { versions, loaderPresent };
  }

  function fail(err: unknown) {
    if (err instanceof ModSourceError) {
      return { code: err.code === 'not-found' ? 404 : 502, body: { error: err.code, message: err.message } };
    }
    return { code: 500, body: { error: 'mod-failed', message: (err as Error).message } };
  }

  // ---- what this server can do -------------------------------------------
  app.get<{ Params: { id: string } }>('/api/servers/:id/mods', operator, async (request, reply) => {
    const found = await context(request.params.id);
    const installed = db.listInstalledMods(request.params.id);

    if (!found.ok) {
      // Still useful: the UI explains why modding is unavailable rather than
      // hiding the tab and leaving the operator guessing.
      return reply.send({
        supported: false,
        reason: (found.error.body as { message?: string }).message ?? 'Unsupported.',
        installed,
        scannerConfigured: Boolean(scannerConfig().virustotalApiKey || scannerConfig().clamavHost),
      });
    }

    const status = await docker.getStatus(found.server);
    const config = scannerConfig();
    return reply.send({
      supported: true,
      source: {
        id: found.source.id,
        label: found.source.label,
        searchable: found.source.searchable,
        lookupHint: found.source.lookupHint,
        loader: found.source.loader,
      },
      running: status.running,
      installed,
      scannerConfigured: Boolean(config.virustotalApiKey || config.clamavHost),
    });
  });

  // ---- finding a mod ------------------------------------------------------
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/api/servers/:id/mods/search',
    operator,
    async (request, reply) => {
      const found = await context(request.params.id);
      if (!found.ok) return reply.code(found.error.code).send(found.error.body);

      const q = (request.query.q ?? '').trim();
      if (!q) return reply.send({ results: [] });

      try {
        // A repository without search still resolves an exact reference, which
        // is how Thunderstore mods are added.
        const results = found.source.searchable
          ? await found.source.search(q)
          : [await found.source.lookup(q)];
        return reply.send({ results });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send(f.body);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { mod?: string } }>(
    '/api/servers/:id/mods/versions',
    operator,
    async (request, reply) => {
      const found = await context(request.params.id);
      if (!found.ok) return reply.code(found.error.code).send(found.error.body);

      const modId = (request.query.mod ?? '').trim();
      if (!modId) return reply.code(400).send({ error: 'no-mod' });

      try {
        return reply.send({ versions: await found.source.versions(modId) });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send(f.body);
      }
    },
  );

  // ---- inspect, then install ----------------------------------------------
  /**
   * Downloads and judges a mod without writing anything. The operator sees
   * this report first; nothing reaches the server until they act on it.
   */
  app.post<{ Params: { id: string }; Body: { source?: string; mod?: string; version?: string } }>(
    '/api/servers/:id/mods/inspect',
    operator,
    async (request, reply) => {
      const found = await context(request.params.id);
      if (!found.ok) return reply.code(found.error.code).send(found.error.body);

      const sourceId = request.body?.source ?? found.source.id;
      const source = getSource(sourceId);
      if (!source || source.id !== found.source.id) {
        return reply.code(400).send({ error: 'wrong-source' });
      }

      const modId = (request.body?.mod ?? '').trim();
      const wanted = (request.body?.version ?? '').trim();
      if (!modId) return reply.code(400).send({ error: 'no-mod' });

      try {
        const summary = await source.lookup(modId);
        const versions = await source.versions(summary.id);
        const version = wanted ? versions.find((v) => v.version === wanted) : versions[0];
        if (!version) return reply.code(404).send({ error: 'no-such-version' });

        const { plan } = await mods.prepare({
          source,
          mod: { id: summary.id, name: summary.name, deprecated: summary.deprecated },
          version,
          layout: found.layout,
          installed: await installedState(found.server, source),
          scanners: scannerConfig(),
        });
        return reply.send({ plan, mod: summary });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send(f.body);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { source?: string; mod?: string; version?: string; acknowledge?: boolean };
  }>('/api/servers/:id/mods/install', operator, async (request, reply) => {
    const user = request.user!;
    const found = await context(request.params.id);
    if (!found.ok) return reply.code(found.error.code).send(found.error.body);

    const status = await docker.getStatus(found.server);
    if (status.running) {
      return reply.code(409).send({
        error: 'server-running',
        message: 'Stop the server before changing which mods it loads.',
      });
    }

    const source = getSource(request.body?.source ?? found.source.id);
    if (!source || source.id !== found.source.id) {
      return reply.code(400).send({ error: 'wrong-source' });
    }

    const modId = (request.body?.mod ?? '').trim();
    const wanted = (request.body?.version ?? '').trim();
    if (!modId) return reply.code(400).send({ error: 'no-mod' });

    try {
      const summary = await source.lookup(modId);
      const versions = await source.versions(summary.id);
      const version = wanted ? versions.find((v) => v.version === wanted) : versions[0];
      if (!version) return reply.code(404).send({ error: 'no-such-version' });

      // Re-judged here rather than trusting a plan from the client: the
      // inspect call is for the operator to read, not a token to be replayed.
      const { plan, body, entries } = await mods.prepare({
        source,
        mod: { id: summary.id, name: summary.name, deprecated: summary.deprecated },
        version,
        layout: found.layout,
        installed: await installedState(found.server, source),
        scanners: scannerConfig(),
      });

      if (!plan.installable) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: found.server.id,
          action: 'mod-install',
          result: 'failure',
          detail: `Refused ${summary.name} ${version.version}: ${plan.findings
            .filter((f) => f.state === 'fail')
            .map((f) => f.summary)
            .join('; ')}`,
          ...originOf(request),
        });
        return reply.code(422).send({ error: 'refused', plan });
      }

      if (plan.needsAcknowledgement && !request.body?.acknowledge) {
        return reply.code(428).send({ error: 'needs-acknowledgement', plan });
      }

      const root = await dataRoot(found.server);
      const files = await mods.commit(found.server, root, plan, body, entries);

      db.recordInstalledMod({
        serverId: found.server.id,
        source: source.id,
        modId: summary.id,
        modName: summary.name,
        version: version.version,
        sha256: plan.sha256,
        directory: plan.targetDirectory,
        files,
        report: { findings: plan.findings, scans: plan.scans, archive: plan.archive },
        installedBy: user.username,
      });

      db.audit({
        userId: user.id,
        username: user.username,
        serverId: found.server.id,
        action: 'mod-install',
        result: 'success',
        // The hash is recorded in the audit trail as well as the mod table, so
        // the log alone says exactly which bytes were installed.
        detail: `${summary.name} ${version.version} (${files.length} files, sha256 ${plan.sha256.slice(0, 16)}…)${
          plan.needsAcknowledgement ? ' — installed over warnings' : ''
        }`,
        ...originOf(request),
      });


      notify.send({
        kind: 'mod-installed',
        server: {
          name: found.server.displayName,
          id: found.server.id,
          steamAppId: found.server.steamAppId,
          iconUrl: found.server.iconUrl,
        },
        actor: { username: user.username, role: user.role },
        detail: `${summary.name} ${version.version}`,
      });
      return reply.send({ installed: true, plan, files: files.length });
    } catch (err) {
      const f = fail(err);
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: found.server.id,
        action: 'mod-install',
        result: 'failure',
        detail: (err as Error).message,
        ...originOf(request),
      });
      return reply.code(f.code).send(f.body);
    }
  });

  app.delete<{ Params: { id: string; source: string; modId: string } }>(
    '/api/servers/:id/mods/:source/:modId',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const status = await docker.getStatus(server);
      if (status.running) {
        return reply.code(409).send({ error: 'server-running', message: 'Stop the server first.' });
      }

      const row = db.getInstalledMod(server.id, request.params.source, request.params.modId);
      if (!row) return reply.code(404).send({ error: 'not-installed' });

      try {
        await mods.remove(
          server,
          await dataRoot(server),
          { directory: row.directory, files: row.files },
          layoutFor(server.query?.type)?.install ?? 'extract',
        );
        db.forgetInstalledMod(server.id, row.source, row.modId);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'mod-remove',
          result: 'success',
          detail: `${row.modName} ${row.version}`,
          ...originOf(request),
        });
        return reply.send({ removed: true });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.code).send(f.body);
      }
    },
  );

  // ---- scanner settings: owner only ---------------------------------------
  app.get('/api/integrations/scanners', owner, async (_request, reply) => {
    const config = scannerConfig();
    // The key itself is never returned, only whether one is set.
    return reply.send({
      virustotal: Boolean(config.virustotalApiKey),
      clamavHost: config.clamavHost ?? '',
      clamavPort: config.clamavPort ?? 3310,
    });
  });

  app.put<{ Body: { virustotalApiKey?: string; clamavHost?: string; clamavPort?: number } }>(
    '/api/integrations/scanners',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const current = scannerConfig();
      const next: ScannerConfig = {
        // An empty field keeps the stored key rather than wiping it, so the
        // form never has to echo a secret back to be saved again.
        virustotalApiKey: request.body?.virustotalApiKey?.trim() || current.virustotalApiKey,
        clamavHost: request.body?.clamavHost?.trim() ?? current.clamavHost,
        clamavPort: request.body?.clamavPort ?? current.clamavPort,
      };
      if (request.body?.virustotalApiKey === '') delete next.virustotalApiKey;
      if (request.body?.clamavHost === '') delete next.clamavHost;

      db.setSetting(SCANNER_KEY, encryptSecret(JSON.stringify(next), env.SESSION_SECRET));
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: null,
        action: 'integration-changed',
        result: 'success',
        detail: 'Updated malware scanner settings',
        ...originOf(request),
      });
      return reply.send({ ok: true });
    },
  );
}
