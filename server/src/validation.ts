import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Catalog } from './catalog.js';
import type { ServerConfig } from './config.js';
import { planDeployment, DeployError, type Deployer } from './deploy.js';
import { createDeployWatcher, type WatchOutcome } from './deployverify.js';
import type { DockerClient } from './docker/client.js';
import type { Db } from './db.js';
import type { Env } from './config.js';
import { passes } from './findings.js';
import { connectSettings, GAMES, identifyGame, type GameProfile } from './games.js';
import type { Notifier } from './notify.js';
import type { GameQuery } from './query/gamedig.js';
import { reviewTemplate } from './review/deploy.js';

/**
 * Validation Runs: proving the registry's data still produces a working
 * server from NOTHING, on the owner's real machine.
 *
 * Per selected game, strictly one at a time: resolve the game to its trusted
 * catalogue template, deploy it under a validation name, follow the first
 * boot with the same Deploy Verification bar a user's deploy gets (the server
 * must answer AS the name it was given), then tear everything down — the
 * container, its volume, its downloads. ADR-0003 says why no cache survives:
 * a run that passes on last month's download has proven nothing about the
 * path a new user walks. Bandwidth is the honest price of the honest test.
 *
 * The outcome vocabulary adds two states to the verification's three:
 * 'refused' (the template failed the same review gate a user would hit — a
 * finding about the catalogue, not this machine) and 'skipped' (this machine
 * could not host the attempt right now, usually a port already owned by a
 * live server — a fact about the box, not the game).
 */

export type GameOutcome = WatchOutcome | 'refused' | 'skipped' | 'error';

export interface GameResult {
  game: string;
  label: string;
  status: 'pending' | 'resolving' | 'deploying' | 'verifying' | 'tearing-down' | 'done';
  outcome: GameOutcome | null;
  note: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ValidationRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  startedBy: string;
  games: GameResult[];
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
      return JSON.parse(db.getSetting(HISTORY_KEY) ?? '[]') as ValidationRun[];
    } catch {
      return [];
    }
  }

  function remember(run: ValidationRun) {
    const all = [run, ...history()].slice(0, HISTORY_LIMIT);
    db.setSetting(HISTORY_KEY, JSON.stringify(all));
  }

  /** Every registry game is offered; whether a template exists is the run's
   * own first finding, not a precondition hidden from the list. */
  function availableGames(): Array<{ key: string; label: string }> {
    return GAMES.map((g) => ({ key: g.key, label: g.label }));
  }

  async function resolveApp(game: GameProfile) {
    const { apps } = await catalog.list();
    for (const app of apps) {
      if (!catalog.isTrusted(app.repository)) continue;
      if (identifyGame(app.name, app.repository) === game) return app;
    }
    return null;
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

  async function runGame(result: GameResult, run: ValidationRun): Promise<void> {
    const game = GAMES.find((g) => g.key === result.game)!;
    result.startedAt = Date.now();
    result.status = 'resolving';

    const app = await resolveApp(game);
    if (!app) {
      result.outcome = 'skipped';
      result.note = 'No trusted catalogue template matches this game, so there is nothing to validate on this path.';
      return;
    }

    const parsed = catalog.template(app);
    const findings = reviewTemplate(app, parsed, catalog.isTrusted);
    if (!passes(findings)) {
      result.outcome = 'refused';
      result.note = `The template fails the same review a user's deploy would: ${findings
        .filter((f) => f.state === 'fail')
        .map((f) => f.summary)
        .join('; ')}`;
      return;
    }

    // The configured name is the proof the verification will demand back.
    const expectedName = `GK Validation ${game.label}`.slice(0, 48);
    const nameSpecs = connectSettings(game).filter((s) => s.connect === 'name');
    const templateTargets = new Set(
      parsed.fields.filter((f) => f.type === 'Variable').map((f) => f.target),
    );
    const variables: Record<string, string> = {};
    const extraVariables: Array<{ name: string; value: string }> = [];
    for (const spec of nameSpecs) {
      if (templateTargets.has(spec.key)) variables[spec.key] = expectedName;
      else extraVariables.push({ name: spec.key, value: expectedName });
    }

    const deployName = `${VALIDATE_PREFIX}${game.key}`.slice(0, 32);
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
      await deployer.create(plan, (m) => log(`validation ${game.key}: ${m}`));
    } catch (err) {
      await teardown(plan.containerName, plan.appdataPath);
      if (err instanceof DeployError) {
        // Usually a port a live server already owns: a fact about this box
        // right now, not about the game's data.
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
      id: `validate-${game.key}`,
      displayName: expectedName,
      container: plan.containerName,
      updateStrategy: 'restart',
      cooldownSeconds: 0,
      query:
        ports.length > 0 ? { type: game.query, host: plan.containerName, port: ports[0]! } : undefined,
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
        result.note = 'The run was cancelled while this game was still booting.';
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

  function start(gameKeys: string[], startedBy: string): ValidationRun {
    if (current && !current.finishedAt) {
      throw new Error('A validation run is already going; one at a time is the whole idea.');
    }
    const games = GAMES.filter((g) => gameKeys.includes(g.key));
    if (games.length === 0) throw new Error('Pick at least one game.');

    const run: ValidationRun = {
      id: randomUUID(),
      startedAt: Date.now(),
      finishedAt: null,
      startedBy,
      cancelled: false,
      games: games.map((g) => ({
        game: g.key,
        label: g.label,
        status: 'pending',
        outcome: null,
        note: null,
        startedAt: null,
        finishedAt: null,
      })),
    };
    current = run;

    void (async () => {
      for (const result of run.games) {
        if (run.cancelled) {
          result.outcome = 'skipped';
          result.note = 'The run was cancelled before this game started.';
          result.status = 'done';
          continue;
        }
        try {
          await runGame(result, run);
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
      for (const g of run.games) {
        counts.set(g.outcome ?? 'error', (counts.get(g.outcome ?? 'error') ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
      void notify.send({
        kind: 'validation-finished',
        server: { name: 'GameKeepr validation' },
        detail: `${run.games.length} game(s): ${summary}${run.cancelled ? ' (cancelled)' : ''}`,
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
    return { current, history: history(), games: availableGames() };
  }

  return { start, cancel, state };
}

export type ValidationRunner = ReturnType<typeof createValidationRunner>;
