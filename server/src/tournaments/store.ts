import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Persistence for tournaments: teams, entries, the bracket's matches, and who
 * organizes what. This module owns its tables and nothing else -- bracket
 * math, scheduling and server provisioning live elsewhere and talk to it.
 *
 * The id/slug split mirrors the registry's id/container split: ids are
 * internal and stable, the slug is the public page's address and may read
 * nicely. Nothing user-supplied ever names a container here either; a match
 * records which container was provisioned for it, and only the orchestrator
 * writes that column.
 */

export type TournamentStatus = 'draft' | 'registration' | 'running' | 'finished';

/** 'bracket' is v1. The column exists so a points-series (battle royale
 * style) format is an addition, not a migration. */
export type TournamentFormat = 'bracket';

export type BestOf = 1 | 3 | 5;

export type MatchStatus =
  | 'pending' // waiting on teams, schedule or an earlier round
  | 'provisioning' // the match server is being created
  | 'ready' // server up, teams may connect
  | 'live' // the game reported the match started
  | 'decided' // a winner stands, by play or by override
  | 'forfeit'; // decided without play

export interface TournamentRow {
  id: string;
  /** The public page's address: /t/<slug>. */
  slug: string;
  name: string;
  game: string;
  format: TournamentFormat;
  teamSize: number;
  maxTeams: number;
  bestOf: BestOf;
  mapPool: string[];
  status: TournamentStatus;
  /** Whether the public page may show who is on each team. Off by default:
   * team names are the public story, people's names are not. */
  publicRosters: boolean;
  createdAt: number;
  createdBy: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TeamMember {
  userId: string;
  /**
   * Steam64 id, for games whose match layer gates player slots on it (CS2's
   * does). Null for members who have not given one yet.
   */
  steamId: string | null;
}

export interface TeamRow {
  id: string;
  name: string;
  captainUserId: string;
  createdAt: number;
  /** Captain included. */
  members: TeamMember[];
}

export interface EntryRow {
  tournamentId: string;
  teamId: string;
  /** 1-based bracket position; null until seeding. */
  seed: number | null;
  registeredAt: number;
}

export interface MapResult {
  map: string;
  scoreA: number;
  scoreB: number;
}

export interface MatchRow {
  id: string;
  tournamentId: string;
  /** 1 = first round; the final is the highest round. */
  round: number;
  /** Position within the round, 0-based. Winner of (r, s) feeds (r+1, s>>1). */
  slot: number;
  teamA: string | null;
  teamB: string | null;
  scheduledAt: number | null;
  bestOf: BestOf;
  status: MatchStatus;
  maps: MapResult[];
  winner: string | null;
  forfeitTeam: string | null;
  overrideBy: string | null;
  overrideReason: string | null;
  /** Container name of the provisioned match server, while one exists. */
  serverContainer: string | null;
  connectHost: string | null;
  connectPort: number | null;
  connectPassword: string | null;
  /** Shared secret the match server's event webhook must present. */
  eventToken: string | null;
  decidedAt: number | null;
}

interface RawTournament {
  id: string;
  slug: string;
  name: string;
  game: string;
  format: string;
  team_size: number;
  max_teams: number;
  best_of: number;
  map_pool: string;
  status: string;
  public_rosters: number;
  created_at: number;
  created_by: string;
  started_at: number | null;
  finished_at: number | null;
}

interface RawMatch {
  id: string;
  tournament_id: string;
  round: number;
  slot: number;
  team_a: string | null;
  team_b: string | null;
  scheduled_at: number | null;
  best_of: number;
  status: string;
  maps: string;
  winner: string | null;
  forfeit_team: string | null;
  override_by: string | null;
  override_reason: string | null;
  server_container: string | null;
  connect_host: string | null;
  connect_port: number | null;
  connect_password: string | null;
  event_token: string | null;
  decided_at: number | null;
}

function parseJsonArray<T>(text: string, keep: (x: unknown) => x is T): T[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter(keep) : [];
  } catch {
    // An unreadable list loses only itself, never the row it belongs to.
    return [];
  }
}

const isString = (x: unknown): x is string => typeof x === 'string';

const isMapResult = (x: unknown): x is MapResult =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as MapResult).map === 'string' &&
  typeof (x as MapResult).scoreA === 'number' &&
  typeof (x as MapResult).scoreB === 'number';

const toBestOf = (n: number): BestOf => (n === 3 || n === 5 ? n : 1);

function toTournament(r: RawTournament): TournamentRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    game: r.game,
    format: 'bracket',
    teamSize: r.team_size,
    maxTeams: r.max_teams,
    bestOf: toBestOf(r.best_of),
    mapPool: parseJsonArray(r.map_pool, isString),
    status: r.status as TournamentStatus,
    publicRosters: r.public_rosters === 1,
    createdAt: r.created_at,
    createdBy: r.created_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function toMatch(r: RawMatch): MatchRow {
  return {
    id: r.id,
    tournamentId: r.tournament_id,
    round: r.round,
    slot: r.slot,
    teamA: r.team_a,
    teamB: r.team_b,
    scheduledAt: r.scheduled_at,
    bestOf: toBestOf(r.best_of),
    status: r.status as MatchStatus,
    maps: parseJsonArray(r.maps, isMapResult),
    winner: r.winner,
    forfeitTeam: r.forfeit_team,
    overrideBy: r.override_by,
    overrideReason: r.override_reason,
    serverContainer: r.server_container,
    connectHost: r.connect_host,
    connectPort: r.connect_port,
    connectPassword: r.connect_password,
    eventToken: r.event_token,
    decidedAt: r.decided_at,
  };
}

export function createTournamentStore(db: DatabaseSync) {
  db.exec(`
    /*
     * A team outlives any one tournament: it is the named group of friends,
     * not an entry. The captain is a plain user reference; what a captain may
     * do is the routes' decision, not the schema's.
     */
    CREATE TABLE IF NOT EXISTS teams (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      captain_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      steam_id TEXT,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id             TEXT PRIMARY KEY,
      slug           TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      game           TEXT NOT NULL,
      format         TEXT NOT NULL DEFAULT 'bracket',
      team_size      INTEGER NOT NULL,
      max_teams      INTEGER NOT NULL,
      best_of        INTEGER NOT NULL DEFAULT 1,
      map_pool       TEXT NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'draft',
      public_rosters INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      created_by     TEXT NOT NULL,
      started_at     INTEGER,
      finished_at    INTEGER
    );

    /*
     * Who runs one tournament. The creator is inserted at creation; further
     * rows are co-organizers. Eligibility (owner or operator only) is
     * enforced where rows are written, same as everywhere else in the portal.
     */
    CREATE TABLE IF NOT EXISTS tournament_organizers (
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (tournament_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tournament_entries (
      tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      seed          INTEGER,
      registered_at INTEGER NOT NULL,
      PRIMARY KEY (tournament_id, team_id)
    );

    /*
     * The bracket, one row per match. (round, slot) is the bracket position:
     * the winner of (r, s) advances to (r+1, s/2). A bye is a round-1 match
     * with one team, decided at generation time. connect_* and event_token
     * live only while a match server exists and are cleared at teardown.
     */
    CREATE TABLE IF NOT EXISTS matches (
      id               TEXT PRIMARY KEY,
      tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      round            INTEGER NOT NULL,
      slot             INTEGER NOT NULL,
      team_a           TEXT,
      team_b           TEXT,
      scheduled_at     INTEGER,
      best_of          INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      maps             TEXT NOT NULL DEFAULT '[]',
      winner           TEXT,
      forfeit_team     TEXT,
      override_by      TEXT,
      override_reason  TEXT,
      server_container TEXT,
      connect_host     TEXT,
      connect_port     INTEGER,
      connect_password TEXT,
      event_token      TEXT,
      decided_at       INTEGER,
      UNIQUE (tournament_id, round, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches (tournament_id, round, slot);
    CREATE INDEX IF NOT EXISTS idx_matches_due
      ON matches (status, scheduled_at) WHERE scheduled_at IS NOT NULL;
  `);

  const st = {
    insertTournament: db.prepare(
      `INSERT INTO tournaments
         (id, slug, name, game, format, team_size, max_teams, best_of, map_pool, status, public_rosters, created_at, created_by)
       VALUES (@id, @slug, @name, @game, 'bracket', @teamSize, @maxTeams, @bestOf, @mapPool, 'draft', @publicRosters, @createdAt, @createdBy)`,
    ),
    getTournament: db.prepare('SELECT * FROM tournaments WHERE id = ?'),
    getTournamentBySlug: db.prepare('SELECT * FROM tournaments WHERE slug = ?'),
    listTournaments: db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC'),
    updateTournament: db.prepare(
      `UPDATE tournaments SET name = @name, team_size = @teamSize, max_teams = @maxTeams,
         best_of = @bestOf, map_pool = @mapPool, public_rosters = @publicRosters
       WHERE id = @id`,
    ),
    setTournamentStatus: db.prepare(
      `UPDATE tournaments SET status = @status,
         started_at  = COALESCE(started_at,  @startedAt),
         finished_at = COALESCE(finished_at, @finishedAt)
       WHERE id = @id`,
    ),
    deleteTournament: db.prepare('DELETE FROM tournaments WHERE id = ?'),

    addOrganizer: db.prepare(
      'INSERT OR IGNORE INTO tournament_organizers (tournament_id, user_id) VALUES (?, ?)',
    ),
    removeOrganizer: db.prepare(
      'DELETE FROM tournament_organizers WHERE tournament_id = ? AND user_id = ?',
    ),
    listOrganizers: db.prepare(
      'SELECT user_id FROM tournament_organizers WHERE tournament_id = ?',
    ),
    isOrganizer: db.prepare(
      'SELECT COUNT(*) AS n FROM tournament_organizers WHERE tournament_id = ? AND user_id = ?',
    ),

    insertTeam: db.prepare(
      'INSERT INTO teams (id, name, captain_user_id, created_at) VALUES (?, ?, ?, ?)',
    ),
    getTeam: db.prepare('SELECT * FROM teams WHERE id = ?'),
    getTeamByName: db.prepare('SELECT * FROM teams WHERE name = ? COLLATE NOCASE'),
    listTeams: db.prepare('SELECT * FROM teams ORDER BY name COLLATE NOCASE'),
    renameTeam: db.prepare('UPDATE teams SET name = ? WHERE id = ?'),
    setCaptain: db.prepare('UPDATE teams SET captain_user_id = ? WHERE id = ?'),
    deleteTeam: db.prepare('DELETE FROM teams WHERE id = ?'),
    teamsOf: db.prepare(
      `SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE`,
    ),
    addMember: db.prepare(
      'INSERT OR IGNORE INTO team_members (team_id, user_id, steam_id) VALUES (?, ?, ?)',
    ),
    setSteamId: db.prepare(
      'UPDATE team_members SET steam_id = ? WHERE team_id = ? AND user_id = ?',
    ),
    removeMember: db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?'),
    listMembers: db.prepare('SELECT user_id, steam_id FROM team_members WHERE team_id = ?'),

    insertEntry: db.prepare(
      'INSERT INTO tournament_entries (tournament_id, team_id, seed, registered_at) VALUES (?, ?, NULL, ?)',
    ),
    deleteEntry: db.prepare(
      'DELETE FROM tournament_entries WHERE tournament_id = ? AND team_id = ?',
    ),
    listEntries: db.prepare(
      `SELECT tournament_id, team_id, seed, registered_at FROM tournament_entries
       WHERE tournament_id = ? ORDER BY COALESCE(seed, 1e9), registered_at`,
    ),
    countEntries: db.prepare(
      'SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?',
    ),
    setSeed: db.prepare(
      'UPDATE tournament_entries SET seed = ? WHERE tournament_id = ? AND team_id = ?',
    ),

    insertMatch: db.prepare(
      `INSERT INTO matches (id, tournament_id, round, slot, team_a, team_b, best_of, status, maps,
                            winner, decided_at)
       VALUES (@id, @tournamentId, @round, @slot, @teamA, @teamB, @bestOf, @status, '[]',
               @winner, @decidedAt)`,
    ),
    getMatch: db.prepare('SELECT * FROM matches WHERE id = ?'),
    getMatchByToken: db.prepare('SELECT * FROM matches WHERE event_token = ?'),
    listMatches: db.prepare(
      'SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, slot',
    ),
    dueMatches: db.prepare(
      `SELECT * FROM matches
       WHERE status = 'pending' AND team_a IS NOT NULL AND team_b IS NOT NULL
         AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
    ),
    /** Matches currently holding a server, for teardown sweeps and capacity. */
    provisionedMatches: db.prepare(
      "SELECT * FROM matches WHERE server_container IS NOT NULL",
    ),
    setSchedule: db.prepare('UPDATE matches SET scheduled_at = ? WHERE id = ?'),
    setMatchStatus: db.prepare('UPDATE matches SET status = ? WHERE id = ?'),
    setTeams: db.prepare('UPDATE matches SET team_a = @teamA, team_b = @teamB WHERE id = @id'),
    setServer: db.prepare(
      `UPDATE matches SET server_container = @container, connect_host = @host,
         connect_port = @port, connect_password = @password, event_token = @eventToken
       WHERE id = @id`,
    ),
    clearServer: db.prepare(
      `UPDATE matches SET server_container = NULL, connect_host = NULL, connect_port = NULL,
         connect_password = NULL, event_token = NULL
       WHERE id = ?`,
    ),
    setMaps: db.prepare('UPDATE matches SET maps = ? WHERE id = ?'),
    decideMatch: db.prepare(
      `UPDATE matches SET status = @status, winner = @winner, forfeit_team = @forfeitTeam,
         override_by = @overrideBy, override_reason = @overrideReason, decided_at = @decidedAt
       WHERE id = @id`,
    ),
  };

  return {
    createTournament(input: {
      name: string;
      slug: string;
      game: string;
      teamSize: number;
      maxTeams: number;
      bestOf: BestOf;
      mapPool: string[];
      publicRosters: boolean;
      createdBy: string;
    }): TournamentRow {
      const id = randomUUID();
      st.insertTournament.run({
        id,
        slug: input.slug,
        name: input.name,
        game: input.game,
        teamSize: input.teamSize,
        maxTeams: input.maxTeams,
        bestOf: input.bestOf,
        mapPool: JSON.stringify(input.mapPool),
        publicRosters: input.publicRosters ? 1 : 0,
        createdAt: Date.now(),
        createdBy: input.createdBy,
      });
      // The creator runs what they created until they hand it to someone.
      st.addOrganizer.run(id, input.createdBy);
      return this.getTournament(id)!;
    },

    getTournament(id: string): TournamentRow | null {
      const raw = st.getTournament.get(id) as RawTournament | undefined;
      return raw ? toTournament(raw) : null;
    },

    getTournamentBySlug(slug: string): TournamentRow | null {
      const raw = st.getTournamentBySlug.get(slug) as RawTournament | undefined;
      return raw ? toTournament(raw) : null;
    },

    listTournaments(): TournamentRow[] {
      return (st.listTournaments.all() as unknown as RawTournament[]).map(toTournament);
    },

    /** Shape changes are a draft-only affair; the routes enforce that. */
    updateTournament(row: {
      id: string;
      name: string;
      teamSize: number;
      maxTeams: number;
      bestOf: BestOf;
      mapPool: string[];
      publicRosters: boolean;
    }) {
      st.updateTournament.run({
        id: row.id,
        name: row.name,
        teamSize: row.teamSize,
        maxTeams: row.maxTeams,
        bestOf: row.bestOf,
        mapPool: JSON.stringify(row.mapPool),
        publicRosters: row.publicRosters ? 1 : 0,
      });
    },

    setTournamentStatus(id: string, status: TournamentStatus) {
      st.setTournamentStatus.run({
        id,
        status,
        startedAt: status === 'running' ? Date.now() : null,
        finishedAt: status === 'finished' ? Date.now() : null,
      });
    },

    /** Cascades through organizers, entries and matches. Teams survive. */
    removeTournament(id: string) {
      st.deleteTournament.run(id);
    },

    addOrganizer: (tournamentId: string, userId: string) =>
      void st.addOrganizer.run(tournamentId, userId),
    removeOrganizer: (tournamentId: string, userId: string) =>
      void st.removeOrganizer.run(tournamentId, userId),
    listOrganizers(tournamentId: string): string[] {
      return (st.listOrganizers.all(tournamentId) as unknown as Array<{ user_id: string }>).map(
        (r) => r.user_id,
      );
    },
    isOrganizer(tournamentId: string, userId: string): boolean {
      return (st.isOrganizer.get(tournamentId, userId) as { n: number }).n > 0;
    },

    createTeam(name: string, captainUserId: string, captainSteamId: string | null = null): TeamRow {
      const id = randomUUID();
      st.insertTeam.run(id, name, captainUserId, Date.now());
      st.addMember.run(id, captainUserId, captainSteamId);
      return this.getTeam(id)!;
    },

    getTeam(id: string): TeamRow | null {
      const raw = st.getTeam.get(id) as
        | { id: string; name: string; captain_user_id: string; created_at: number }
        | undefined;
      if (!raw) return null;
      return {
        id: raw.id,
        name: raw.name,
        captainUserId: raw.captain_user_id,
        createdAt: raw.created_at,
        members: (
          st.listMembers.all(raw.id) as unknown as Array<{ user_id: string; steam_id: string | null }>
        ).map((r) => ({ userId: r.user_id, steamId: r.steam_id })),
      };
    },

    findTeamByName(name: string): TeamRow | null {
      const raw = st.getTeamByName.get(name) as { id: string } | undefined;
      return raw ? this.getTeam(raw.id) : null;
    },

    listTeams(): TeamRow[] {
      const rows = st.listTeams.all() as unknown as Array<{ id: string }>;
      return rows.flatMap((r) => this.getTeam(r.id) ?? []);
    },

    teamsForUser(userId: string): TeamRow[] {
      const rows = st.teamsOf.all(userId) as unknown as Array<{ id: string }>;
      return rows.flatMap((r) => this.getTeam(r.id) ?? []);
    },

    renameTeam: (id: string, name: string) => void st.renameTeam.run(name, id),
    setTeamCaptain: (id: string, userId: string) => void st.setCaptain.run(userId, id),
    removeTeam: (id: string) => void st.deleteTeam.run(id),
    addTeamMember: (teamId: string, userId: string, steamId: string | null = null) =>
      void st.addMember.run(teamId, userId, steamId),
    setMemberSteamId: (teamId: string, userId: string, steamId: string | null) =>
      void st.setSteamId.run(steamId, teamId, userId),
    removeTeamMember: (teamId: string, userId: string) =>
      void st.removeMember.run(teamId, userId),

    registerEntry(tournamentId: string, teamId: string) {
      st.insertEntry.run(tournamentId, teamId, Date.now());
    },
    withdrawEntry(tournamentId: string, teamId: string) {
      st.deleteEntry.run(tournamentId, teamId);
    },
    listEntries(tournamentId: string): EntryRow[] {
      const rows = st.listEntries.all(tournamentId) as unknown as Array<{
        tournament_id: string;
        team_id: string;
        seed: number | null;
        registered_at: number;
      }>;
      return rows.map((r) => ({
        tournamentId: r.tournament_id,
        teamId: r.team_id,
        seed: r.seed,
        registeredAt: r.registered_at,
      }));
    },
    countEntries(tournamentId: string): number {
      return (st.countEntries.get(tournamentId) as { n: number }).n;
    },
    setSeed(tournamentId: string, teamId: string, seed: number | null) {
      st.setSeed.run(seed, tournamentId, teamId);
    },

    /**
     * Inserts one bracket position. A bye arrives here already decided --
     * one team, a winner, no play -- so the engine never has to treat "no
     * opponent" as a kind of result later.
     */
    addMatch(row: {
      tournamentId: string;
      round: number;
      slot: number;
      teamA: string | null;
      teamB: string | null;
      bestOf: BestOf;
      /** Set for byes; everything else starts pending and undecided. */
      decidedWinner?: string;
    }): MatchRow {
      const id = randomUUID();
      st.insertMatch.run({
        id,
        tournamentId: row.tournamentId,
        round: row.round,
        slot: row.slot,
        teamA: row.teamA,
        teamB: row.teamB,
        bestOf: row.bestOf,
        status: row.decidedWinner ? 'decided' : 'pending',
        winner: row.decidedWinner ?? null,
        decidedAt: row.decidedWinner ? Date.now() : null,
      });
      return this.getMatch(id)!;
    },

    getMatch(id: string): MatchRow | null {
      const raw = st.getMatch.get(id) as RawMatch | undefined;
      return raw ? toMatch(raw) : null;
    },

    /** Resolves a webhook's bearer token to its match; the only lookup the
     * event endpoint is allowed to make. */
    getMatchByEventToken(token: string): MatchRow | null {
      const raw = st.getMatchByToken.get(token) as RawMatch | undefined;
      return raw ? toMatch(raw) : null;
    },

    listMatches(tournamentId: string): MatchRow[] {
      return (st.listMatches.all(tournamentId) as unknown as RawMatch[]).map(toMatch);
    },

    /** Matches whose server should exist by now but does not yet. */
    dueMatches(now: number): MatchRow[] {
      return (st.dueMatches.all(now) as unknown as RawMatch[]).map(toMatch);
    },

    provisionedMatches(): MatchRow[] {
      return (st.provisionedMatches.all() as unknown as RawMatch[]).map(toMatch);
    },

    scheduleMatch: (id: string, at: number | null) => void st.setSchedule.run(at, id),
    setMatchStatus: (id: string, status: MatchStatus) => void st.setMatchStatus.run(status, id),
    setMatchTeams(id: string, teamA: string | null, teamB: string | null) {
      st.setTeams.run({ id, teamA, teamB });
    },

    attachServer(
      id: string,
      server: {
        container: string;
        host: string;
        port: number;
        password: string;
        eventToken: string;
      },
    ) {
      st.setServer.run({ id, ...server });
    },

    detachServer: (id: string) => void st.clearServer.run(id),

    recordMaps(id: string, maps: MapResult[]) {
      st.setMaps.run(JSON.stringify(maps), id);
    },

    /** The one way a match gets a winner: play, forfeit or override. */
    decideMatch(row: {
      id: string;
      status: Extract<MatchStatus, 'decided' | 'forfeit'>;
      winner: string;
      forfeitTeam?: string | null;
      overrideBy?: string | null;
      overrideReason?: string | null;
    }) {
      st.decideMatch.run({
        id: row.id,
        status: row.status,
        winner: row.winner,
        forfeitTeam: row.forfeitTeam ?? null,
        overrideBy: row.overrideBy ?? null,
        overrideReason: row.overrideReason ?? null,
        decidedAt: Date.now(),
      });
    },
  };
}

export type TournamentStore = ReturnType<typeof createTournamentStore>;
