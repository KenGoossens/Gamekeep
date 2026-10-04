import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Catalog } from './catalog.js';
import type { ServerConfig } from './config.js';
import { planDeployment, slugify, DeployError, type Deployer } from './deploy.js';
import { createDeployWatcher, type WatchOutcome } from './deployverify.js';
import type { DockerClient } from './docker/client.js';
import type { Db } from './db.js';
import type { Env } from './config.js';
import { passes } from './findings.js';
import { connectSettings, identifyGame } from './games.js';
import type { Notifier } from './notify.js';
import type { GameQuery } from './query/gamedig.js';
import { reviewTemplate } from './review/deploy.js';

/**
 * Validation Runs: proving that what the portal offers still produces a
 * working server from NOTHING, on the owner's real machine.
 *
 * The targets are catalogue apps — anything the Add server tab would let an
 * operator deploy — not just the games the registry recognises. A recognised
 * game gets the full verification ladder (the server must answer AS the name
 * it was given); an unrecognised one is honestly verified as far as it can
 * be, which is its port accepting connections. Per app, strictly one at a
 * time: deploy under a validation name, follow the first boot with the same
 * Deploy Verification bar a user's deploy gets, then tear everything down —
 * the container, its volume, its downloads. ADR-0003 says why no cache
 * survives: a run that passes on last month's download has proven nothing
 * about the path a new user walks. Bandwidth is the honest price.
 *
 * The outcome vocabulary adds two states to the verification's three:
 * 'refused' (the app failed the same review gate a user would hit — a finding
 * about the catalogue, not this machine) and 'skipped' (this machine could
 * not host the attempt right now, usually a port already owned by a live
 * server — a fact about the box, not the app).
 */

export type AppOutcome = WatchOutcome | 'refused' | 'skipped' | 'error';

export interface AppResult {
  /** The catalogue app id this row validates. */
  app: string;
  label: string;
  status: 'pending' | 'resolving' | 'deploying' | 'verifying' | 'tearing-down' | 'done';
  outcome: AppOutcome | null;
  note: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ValidationRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  startedBy: string;
  apps: AppResult[];
  cancelled: boolean;
}

const HISTORY_KEY = 'validation.history';
const HISTORY_LIMIT = 20;
const VALIDATE_PREFIX = 'gk-validate-';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createValidationRunner(deps: {
  docker: DockerClient;
  gameQuery: GameQuery;
  catalog: Catalog;
  deployer: Deployer;
  db: Db;
  env: Env;
  notify: Notifier;
  log: (message: string) => void;
}) {
  const { docker, gameQuery, catalog, deployer, db, env, notify, log } = deps;
  // Its own watcher, with no settled-listeners: a validation boot must not
  // audit or Discord-ping as if someone deployed a server. The run reports
  // once, as itself.
  const watcher = createDeployWatcher(docker, gameQuery);

  let current: ValidationRun | null = null;

  function history(): ValidationRun[] {
    try {
      const raw = JSON.parse(db.getSetting(HISTORY_KEY) ?? '[]') as Array<
        ValidationRun & { games?: AppResult[] }
      >;
      // Runs recorded when the targets were registry games rather than
      // catalogue apps: carried over, not thrown away.
      return raw.map((run) => ({
        ...run,
        apps: (run.apps ?? run.games ?? []).map((row) => ({
          ...row,
          app: row.app ?? (row as { game?: string }).game ?? row.label,
        })),
      }));
    } catch {
      return [];
    }
  }

  function remember(run: ValidationRun) {
    const all = [run, ...history()].slice(0, HISTORY_LIMIT);
    db.setSetting(HISTORY_KEY, JSON.stringify(all));
  }

  async function teardown(containerName: string, appdataPath: string | null) {
    try {
      const container = docker.docker.getContainer(containerName);
      await container.stop({ t: 15 }).catch(() => undefined);
      await container.remove({ v: true, force: true });
    } catch {
      // Never created, or already gone — both fine at teardown.
    }
    // The downloads: only ever a path we generated ourselves, and only when
    // it carries the validation marker — a safety the rm call insists on.
    if (appdataPath && appdataPath.includes(VALIDATE_PREFIX)) {
      await rm(appdataPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function runApp(result: AppResult, run: ValidationRun): Promise<void> {
    result.startedAt = Date.now();
    result.status = 'resolving';

    const app = await catalog.find(result.app);
    if (!app) {
      result.outcome = 'skipped';
      result.note = 'This app is no longer in the catalogue.';
      return;
    }
    result.label = app.name;
    if (!catalog.isTrusted(app.repository)) {
      result.outcome = 'refused';
      result.note = `${app.publisher} is not on the trusted-publisher list — the same refusal a deploy would get.`;
      return;
    }

    let parsed;
    try {
      parsed = catalog.template(app);
    } catch (err) {
      result.outcome = 'refused';
      result.note = (err as Error).message;
      return;
    }
    const findings = reviewTemplate(app, parsed, catalog.isTrusted);
    if (!passes(findings)) {
      result.outcome = 'refused';
      result.note = `The template fails the same review a user's deploy would: ${findings
        .filter((f) => f.state === 'fail')
        .map((f) => f.summary)
        .join('; ')}`;
      return;
    }

    /*
     * A recognised game raises the bar: its connect-name variables are set so
     * the verification can demand the name back as proof the configuration
     * landed. An unrecognised app has no such lever — its proof stops at a
     * port accepting connections, and the outcome note says so.
     */
    const game = identifyGame(app.name, app.repository);
    const expectedName = `GK Validation ${(game?.label ?? app.name).slice(0, 32)}`;
    const nameSpecs = game ? connectSettings(game).filter((s) => s.connect === 'name') : [];
    const templateTargets = new Set(
      parsed.fields.filter((f) => f.type === 'Variable').map((f) => f.target),
    );
    const variables: Record<string, string> = {};
    const extraVariables: Array<{ name: string; value: string }> = [];
    for (const spec of nameSpecs) {
      if (templateTargets.has(spec.key)) variables[spec.key] = expectedName;
      else extraVariables.push({ name: spec.key, value: expectedName });
    }

    const deployName = `${VALIDATE_PREFIX}${slugify(game?.key ?? app.id) || 'app'}`.slice(0, 32);
    let plan;
    try {
      plan = planDeployment(
        app,
        parsed,
        { name: deployName, variables, ports: {}, extra: { variables: extraVariables, ports: [], paths: [] } },
        env.APPDATA_ROOT,
        env.APPDATA_HOST_ROOT,
        env.GAME_NETWORK,
      );
    } catch (err) {
      result.outcome = 'error';
      result.note = `Planning the deploy failed: ${(err as Error).message}`;
      return;
    }

    result.status = 'deploying';
    try {
      await deployer.ensureNetwork(env.GAME_NETWORK, () => undefined);
      await deployer.create(plan, (m) => log(`validation ${result.app}: ${m}`));
    } catch (err) {
      await teardown(plan.containerName, plan.appdataPath);
      if (err instanceof DeployError) {
        // Usually a port a live server already owns: a fact about this box
        // right now, not about the app's data.
        result.outcome = 'skipped';
        result.note = `Could not host the attempt: ${err.message}`;
        return;
      }
      result.outcome = 'error';
      result.note = (err as Error).message;
      return;
    }

    // The ephemeral server the verification watches: never registered, never
    // on anyone's Servers page — it exists for this proof alone.
    const ports = Object.keys(plan.portBindings)
      .map((spec) => Number(spec.split('/')[0]))
      .filter((p) => Number.isFinite(p))
      .sort((a, b) => a - b);
    const server: ServerConfig = {
      id: `validate-${slugify(app.id) || 'app'}`,
      displayName: expectedName,
      container: plan.containerName,
      updateStrategy: 'restart',
      cooldownSeconds: 0,
      query:
        game && ports.length > 0
          ? { type: game.query, host: plan.containerName, port: ports[0]! }
          : undefined,
    } as ServerConfig;

    result.status = 'verifying';
    try {
      const watch = watcher.start(server, nameSpecs.length > 0 ? expectedName : null);
      while (watcher.getWatch(watch.id)?.phase !== 'settled') {
        if (run.cancelled) break;
        await sleep(5000);
      }
      const settled = watcher.getWatch(watch.id);
      if (run.cancelled && (!settled || settled.phase !== 'settled')) {
        result.outcome = 'skipped';
        result.note = 'The run was cancelled while this app was still booting.';
      } else {
        result.outcome = settled?.outcome ?? 'error';
        result.note = settled?.note ?? 'The verification watch disappeared.';
      }
    } finally {
      result.status = 'tearing-down';
      await teardown(plan.containerName, plan.appdataPath);
      gameQuery.invalidate(server.id);
    }
  }

  function start(appIds: string[], startedBy: string): ValidationRun {
    if (current && !current.finishedAt) {
      throw new Error('A validation run is already going; one at a time is the whole idea.');
    }
    const ids = [...new Set(appIds.map((id) => String(id)).filter(Boolean))];
    if (ids.length === 0) throw new Error('Pick at least one app.');

    const run: ValidationRun = {
      id: randomUUID(),
      startedAt: Date.now(),
      finishedAt: null,
      startedBy,
      cancelled: false,
      apps: ids.map((id) => ({
        app: id,
        label: id,
        status: 'pending',
        outcome: null,
        note: null,
        startedAt: null,
        finishedAt: null,
      })),
    };
    current = run;

    void (async () => {
      for (const result of run.apps) {
        if (run.cancelled) {
          result.outcome = 'skipped';
          result.note = 'The run was cancelled before this app started.';
          result.status = 'done';
          continue;
        }
        try {
          await runApp(result, run);
        } catch (err) {
          result.outcome = 'error';
          result.note = (err as Error).message;
        }
        result.status = 'done';
        result.finishedAt = Date.now();
      }
      run.finishedAt = Date.now();
      remember(run);

      const counts = new Map<string, number>();
      for (const a of run.apps) {
        counts.set(a.outcome ?? 'error', (counts.get(a.outcome ?? 'error') ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
      void notify.send({
        kind: 'validation-finished',
        server: { name: 'GameKeepr validation' },
        detail: `${run.apps.length} app(s): ${summary}${run.cancelled ? ' (cancelled)' : ''}`,
      });
      log(`validation run finished: ${summary}`);
    })();

    return run;
  }

  function cancel(): boolean {
    if (!current || current.finishedAt) return false;
    current.cancelled = true;
    return true;
  }

  function state() {
    return { current, history: history() };
  }

  return { start, cancel, state };
}

export type ValidationRunner = ReturnType<typeof createValidationRunner>;
