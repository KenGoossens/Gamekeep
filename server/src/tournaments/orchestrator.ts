import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../config.js';
import type { Db } from '../db.js';
import type { Deployer } from '../deploy.js';
import type { DockerClient } from '../docker/client.js';
import type { GsltService } from '../steam/gslt.js';
import {
  CS2_SHARED_DIR,
  MATCH_PORT_RANGE,
  buildMatchServerPlan,
  buildMatchZyConfig,
  ensureCs2Addons,
} from './cs2.js';
import { advanceFrom } from './engine.js';
import { rconConnect } from './rcon.js';
import type { MapResult, MatchRow, TournamentStore } from './store.js';

/**
 * Walks matches through their server lifecycle.
 *
 * The tick is the whole machine: retire servers whose match is decided, then
 * -- if nothing is mid-boot and there is capacity -- provision the next due
 * match. Boots are strictly one at a time because every match server shares
 * one installation, and two steamcmd runs writing it concurrently is how
 * installs corrupt. A provisioned server is told about its match over rcon,
 * and from then on MatchZy drives: its webhook events carry the scores in and
 * decide the match, at which point the next tick tears the server down.
 */

/** How far ahead of the scheduled time a server is built. */
const LEAD_MS = 15 * 60 * 1000;

/** First boot downloads the full game; later boots take a minute or two. */
const READY_TIMEOUT_MS = 90 * 60 * 1000;
const READY_POLL_MS = 15 * 1000;

const TICK_MS = 30 * 1000;

export interface MatchOrchestratorDeps {
  store: TournamentStore;
  deployer: Deployer;
  docker: DockerClient;
  gslt: GsltService;
  db: Db;
  env: Env;
  log: (message: string) => void;
}

/** Where MatchZy reaches the portal: over the shared docker network, never
 * through the public URL -- that door has Cloudflare Access in front. */
const internalBase = (env: Env) => `http://${hostname()}:${env.PORT}`;

export function createMatchOrchestrator(deps: MatchOrchestratorDeps) {
  const { store, deployer, docker, gslt, db, env, log } = deps;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  function concurrency(): number {
    const raw = Number(db.getSetting('match-concurrency') ?? '');
    return Number.isInteger(raw) && raw >= 1 && raw <= 8 ? raw : 2;
  }

  const containerNameFor = (match: MatchRow) => `gk-match-${match.id.slice(0, 8)}`;

  async function allocatePort(): Promise<number | null> {
    const taken = new Set<number>();
    for (const m of store.provisionedMatches()) {
      if (m.connectPort) taken.add(m.connectPort);
    }
    const used = await deployer.usedHostPorts();
    for (let port = MATCH_PORT_RANGE.first; port <= MATCH_PORT_RANGE.last; port++) {
      if (taken.has(port)) continue;
      if (used.has(`${port}/tcp`) || used.has(`${port}/udp`)) continue;
      return port;
    }
    return null;
  }

  async function containerExists(name: string): Promise<boolean> {
    try {
      await docker.docker.getContainer(name).inspect();
      return true;
    } catch {
      return false;
    }
  }

  /** The rcon password lives in the container's env, nowhere else; reading it
   * back from the container makes a portal restart mid-boot survivable. */
  async function rconPasswordOf(containerName: string): Promise<string | null> {
    try {
      const info = await docker.docker.getContainer(containerName).inspect();
      for (const entry of info.Config?.Env ?? []) {
        if (entry.startsWith('CS2_RCONPW=')) return entry.slice('CS2_RCONPW='.length);
      }
    } catch {
      // Fall through: a missing container answers null like a missing var.
    }
    return null;
  }

  async function teardown(match: MatchRow): Promise<void> {
    const name = match.serverContainer;
    if (!name) return;
    log(`Match ${match.id.slice(0, 8)}: retiring ${name}`);
    try {
      const container = docker.docker.getContainer(name);
      await container.stop({ t: 10 }).catch(() => undefined);
      await container.remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) {
        log(`Match ${match.id.slice(0, 8)}: could not remove ${name}: ${(err as Error).message}`);
        return; // Keep the row attached so the next tick tries again.
      }
    }
    store.detachServer(match.id);

    // The token was minted for this match alone; it retires with it.
    if (gslt.configured()) {
      try {
        const memo = `gamekeepr:${match.id}`;
        for (const token of await gslt.listTokens()) {
          if (token.memo === memo) await gslt.deleteToken(token.steamId);
        }
      } catch (err) {
        log(`Match ${match.id.slice(0, 8)}: GSLT cleanup failed: ${(err as Error).message}`);
      }
    }

    db.audit({
      userId: null,
      username: 'tournament',
      serverId: null,
      action: 'match-server-removed',
      result: 'success',
      detail: `${name} retired (match ${match.id.slice(0, 8)})`,
    });
  }

  /**
   * Polls until the server answers rcon, then hands it its match. Spawned,
   * not awaited: a first boot downloads the whole game and nothing else
   * should wait behind that.
   */
  async function readyLoop(matchId: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const match = store.getMatch(matchId);
      // Decided, torn down, or re-provisioned elsewhere: this loop is stale.
      if (!match || match.status !== 'provisioning' || !match.serverContainer) return;

      const password = await rconPasswordOf(match.serverContainer);
      if (password && match.connectPort) {
        try {
          const rcon = await rconConnect(match.serverContainer, match.connectPort, password);
          try {
            const base = internalBase(env);
            await rcon.exec(`matchzy_remote_log_url "${base}/api/tournaments/match-event"`);
            await rcon.exec('matchzy_remote_log_header_key "X-GameKeepr-Token"');
            await rcon.exec(`matchzy_remote_log_header_value "${match.eventToken}"`);
            const answer = await rcon.exec(
              `matchzy_loadmatch_url "${base}/api/tournaments/match-config/${match.eventToken}"`,
            );
            if (/unknown command/i.test(answer)) {
              // The server is up but MatchZy is not in it; a result can never
              // arrive, so say it loudly rather than look "ready".
              log(
                `Match ${matchId.slice(0, 8)}: ${match.serverContainer} is up but MatchZy did not load — check the gamekeepr addon bundle in ${CS2_SHARED_DIR}.`,
              );
              return;
            }
            store.setMatchStatus(matchId, 'ready');
            log(
              `Match ${matchId.slice(0, 8)}: ${match.serverContainer} is ready on port ${match.connectPort}`,
            );
            return;
          } finally {
            rcon.close();
          }
        } catch {
          // Not up yet: steamcmd still downloading, or the game still loading.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    log(`Match ${matchId.slice(0, 8)}: gave up waiting for the server to answer rcon.`);
  }

  async function provision(match: MatchRow): Promise<void> {
    const tournament = store.getTournament(match.tournamentId);
    if (!tournament || tournament.status !== 'running') return;
    if (!match.teamA || !match.teamB) return;
    const teamA = store.getTeam(match.teamA);
    const teamB = store.getTeam(match.teamB);
    if (!teamA || !teamB) return;

    const port = await allocatePort();
    if (port === null) {
      log(`Match ${match.id.slice(0, 8)}: no free match port; waiting for one to retire.`);
      return;
    }

    const sharedPath = join(env.APPDATA_ROOT, CS2_SHARED_DIR);
    const sharedHostPath = join(env.APPDATA_HOST_ROOT, CS2_SHARED_DIR);
    try {
      await ensureCs2Addons(sharedPath, log);
    } catch (err) {
      // With a bundle already on disk the show can go on; without one the
      // server would boot bare and never report, which is worse than waiting.
      log(`Match ${match.id.slice(0, 8)}: addon refresh failed: ${(err as Error).message}`);
      const { existsSync } = await import('node:fs');
      if (!existsSync(join(sharedPath, 'gamekeepr', 'matchzy.zip'))) return;
    }

    let token: string | null = null;
    if (gslt.configured()) {
      try {
        token = (await gslt.createToken(`gamekeepr:${match.id}`)).token;
      } catch (err) {
        log(`Match ${match.id.slice(0, 8)}: GSLT mint failed: ${(err as Error).message}`);
        return; // Without a token friends outside the LAN cannot join; retry next tick.
      }
    } else {
      log(`Match ${match.id.slice(0, 8)}: no Steam key configured — server will be LAN-only.`);
    }

    const containerName = containerNameFor(match);
    const password = randomBytes(4).toString('hex');
    const rconPassword = randomBytes(16).toString('hex');
    const eventToken = randomBytes(24).toString('hex');

    // Recorded before the container exists, so a crash between the two leaves
    // a row pointing at a name the recovery pass knows how to check.
    store.attachServer(match.id, {
      container: containerName,
      host: env.LAN_ADDRESS || hostname(),
      port,
      password,
      eventToken,
    });
    store.setMatchStatus(match.id, 'provisioning');

    try {
      await deployer.ensureNetwork(env.GAME_NETWORK, log);
      await deployer.create(
        buildMatchServerPlan({
          containerName,
          serverName: `${tournament.name} — ${teamA.name} vs ${teamB.name}`,
          port,
          password,
          rconPassword,
          gslt: token,
          maxPlayers: tournament.teamSize * 2 + 2,
          network: env.GAME_NETWORK,
          sharedPath,
          sharedHostPath,
        }),
        log,
      );
    } catch (err) {
      log(`Match ${match.id.slice(0, 8)}: provision failed: ${(err as Error).message}`);
      store.detachServer(match.id);
      store.setMatchStatus(match.id, 'pending');
      return;
    }

    db.audit({
      userId: null,
      username: 'tournament',
      serverId: null,
      action: 'match-server-created',
      result: 'success',
      detail: `${containerName} on port ${port} for ${teamA.name} vs ${teamB.name}`,
    });
    void readyLoop(match.id);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const provisioned = store.provisionedMatches();

      for (const match of provisioned) {
        if (match.status === 'decided' || match.status === 'forfeit') await teardown(match);
      }

      // One boot at a time; see the module comment for why.
      if (provisioned.some((m) => m.status === 'provisioning')) return;

      const active = store.provisionedMatches().length;
      if (active >= concurrency()) return;

      const due = store
        .dueMatches(Date.now() + LEAD_MS)
        .filter((m) => store.getTournament(m.tournamentId)?.status === 'running');
      const next = due[0];
      if (next) await provision(next);
    } catch (err) {
      log(`Tournament tick failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  }

  /** Reconciles rows with reality after a portal restart. */
  async function recover(): Promise<void> {
    for (const match of store.provisionedMatches()) {
      const exists = match.serverContainer ? await containerExists(match.serverContainer) : false;
      if (!exists) {
        // The row promised a server that is not there: back to the queue.
        store.detachServer(match.id);
        if (match.status === 'provisioning' || match.status === 'ready' || match.status === 'live') {
          store.setMatchStatus(match.id, 'pending');
        }
      } else if (match.status === 'provisioning') {
        void readyLoop(match.id);
      }
    }
  }

  /**
   * Applies one MatchZy webhook event. The caller has already resolved the
   * token to this match; everything in the payload is still just a game
   * server's claim, parsed defensively and never echoed anywhere dangerous.
   */
  function applyEvent(match: MatchRow, payload: Record<string, unknown>): void {
    const event = typeof payload.event === 'string' ? payload.event : '';
    // Config team1 is teamA by construction (buildMatchZyConfig).
    const teamFor = (side: unknown): string | null =>
      side === 'team1' || side === 1 ? match.teamA : side === 'team2' || side === 2 ? match.teamB : null;
    const winnerOf = (value: unknown): string | null =>
      typeof value === 'object' && value !== null
        ? teamFor((value as { team?: unknown }).team)
        : null;
    const scoreOf = (value: unknown): number =>
      typeof value === 'object' && value !== null && typeof (value as { score?: unknown }).score === 'number'
        ? (value as { score: number }).score
        : 0;

    const mapNumber = typeof payload.map_number === 'number' ? payload.map_number : 0;
    const maps: MapResult[] = [...match.maps];
    const ensureMap = (): MapResult => {
      while (maps.length <= mapNumber) maps.push({ map: '', scoreA: 0, scoreB: 0 });
      return maps[mapNumber]!;
    };

    switch (event) {
      case 'going_live':
        store.setMatchStatus(match.id, 'live');
        ensureMap();
        store.recordMaps(match.id, maps);
        return;
      case 'map_picked': {
        const entry = ensureMap();
        if (typeof payload.map_name === 'string') entry.map = payload.map_name;
        store.recordMaps(match.id, maps);
        return;
      }
      case 'round_end':
      case 'map_result': {
        const entry = ensureMap();
        entry.scoreA = scoreOf(payload.team1);
        entry.scoreB = scoreOf(payload.team2);
        store.recordMaps(match.id, maps);
        return;
      }
      case 'series_end': {
        // An organizer's override outranks the game; a late event must not
        // quietly undo a deliberate decision.
        if (match.status === 'decided' || match.status === 'forfeit') return;
        const winner = winnerOf(payload.winner);
        if (!winner) return;
        store.decideMatch({ id: match.id, status: 'decided', winner });
        // The bracket moves the moment the game says so: the winner lands in
        // the next round, and a decided final ends the tournament.
        advanceFrom(store, match.id);
        log(`Match ${match.id.slice(0, 8)}: series ended, winner recorded.`);
        return;
      }
      default:
        return; // Plenty of events exist that this portal has no use for yet.
    }
  }

  return {
    start() {
      void recover();
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    /** One pass, on demand -- used by tests and by routes that cannot wait. */
    tick,
    applyEvent,
    buildConfigFor(match: MatchRow): Record<string, unknown> | null {
      const tournament = store.getTournament(match.tournamentId);
      if (!tournament || !match.teamA || !match.teamB) return null;
      const teamA = store.getTeam(match.teamA);
      const teamB = store.getTeam(match.teamB);
      if (!teamA || !teamB) return null;
      const players = (team: typeof teamA): Record<string, string> =>
        Object.fromEntries(
          team.members.filter((m) => m.steamId).map((m) => [m.steamId!, m.userId]),
        );
      return buildMatchZyConfig({
        match,
        tournament,
        teamAName: teamA.name,
        teamBName: teamB.name,
        teamAPlayers: players(teamA),
        teamBPlayers: players(teamB),
      });
    },
  };
}

export type MatchOrchestrator = ReturnType<typeof createMatchOrchestrator>;
