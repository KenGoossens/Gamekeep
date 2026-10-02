import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { canOperate, type SessionUser } from '../db.js';
import { slugify } from '../deploy.js';
import { BracketError, generateBracket, overrideResult, scheduleRound } from '../tournaments/engine.js';
import { buildPublicData, renderFragment, renderPublicPage } from '../tournaments/publicPage.js';
import type { BestOf, TournamentRow } from '../tournaments/store.js';

/**
 * Tournaments (beta): the whole feature carries that label until it has been
 * tested and validated end to end, and the API says so in every listing.
 *
 * Who may do what follows the grilled design: owners and operators create
 * tournaments; the creator is its Organizer and may appoint co-organizers
 * (owners/operators only). Members create and captain teams. The two
 * token-authenticated machine endpoints at the bottom are what a match
 * server talks to; they have no session because they have no user.
 */
export function registerTournamentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { tournaments, matches, db, guard } = ctx;
  const member = { preHandler: guard.requireActiveUser };
  const operator = { preHandler: guard.requireOperator };

  /** Organizer of this tournament, or the owner — who is never overridable. */
  function organizes(user: SessionUser, tournamentId: string): boolean {
    if (user.role === 'owner') return true;
    return canOperate(user.role) && tournaments.isOrganizer(tournamentId, user.id);
  }

  function findTournament(request: FastifyRequest, reply: FastifyReply): TournamentRow | null {
    const id = String((request.params as { id?: string }).id ?? '');
    const tournament = tournaments.getTournament(id);
    if (!tournament) {
      void reply.code(404).send({ error: 'unknown-tournament' });
      return null;
    }
    return tournament;
  }

  function requireOrganizer(
    request: FastifyRequest,
    reply: FastifyReply,
  ): TournamentRow | null {
    const tournament = findTournament(request, reply);
    if (!tournament) return null;
    if (!organizes(request.user!, tournament.id)) {
      void reply.code(403).send({ error: 'organizer-required' });
      return null;
    }
    return tournament;
  }

  const bestOfOf = (value: unknown): BestOf => (value === 3 || value === 5 ? value : 1);

  const mapsOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((m): m is string => typeof m === 'string')
          .map((m) => m.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
          .filter((m) => m.length > 1)
          .slice(0, 20)
      : [];

  function describeTournament(t: TournamentRow) {
    const entries = tournaments.listEntries(t.id);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      game: t.game,
      format: t.format,
      teamSize: t.teamSize,
      maxTeams: t.maxTeams,
      bestOf: t.bestOf,
      mapPool: t.mapPool,
      status: t.status,
      publicRosters: t.publicRosters,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      entryCount: entries.length,
      organizers: tournaments.listOrganizers(t.id),
      beta: true,
    };
  }

  // ---- tournaments ------------------------------------------------------

  app.get('/api/tournaments', member, async (_request, reply) => {
    return reply.send({ beta: true, tournaments: tournaments.listTournaments().map(describeTournament) });
  });

  app.post<{
    Body: {
      name?: string;
      teamSize?: number;
      maxTeams?: number;
      bestOf?: number;
      mapPool?: string[];
      publicRosters?: boolean;
    };
  }>('/api/tournaments', operator, async (request, reply) => {
    const user = request.user!;
    const body = request.body ?? {};
    const name = String(body.name ?? '').replace(/[\r\n]/g, ' ').trim();
    if (name.length < 3 || name.length > 60) {
      return reply.code(400).send({ error: 'bad-name', message: 'Give the tournament a name of 3 to 60 characters.' });
    }
    const teamSize = Number(body.teamSize);
    if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 16) {
      return reply.code(400).send({ error: 'bad-team-size', message: 'Team size must be 1 to 16.' });
    }
    const maxTeams = Number(body.maxTeams);
    if (!Number.isInteger(maxTeams) || maxTeams < 2 || maxTeams > 64) {
      return reply.code(400).send({ error: 'bad-max-teams', message: 'Allow between 2 and 64 teams.' });
    }
    const mapPool = mapsOf(body.mapPool);
    if (mapPool.length === 0) {
      return reply.code(400).send({ error: 'bad-map-pool', message: 'Name at least one map.' });
    }

    // The slug is the public page's address; collisions get a suffix rather
    // than an error, because "Friday CS2" will absolutely happen twice.
    let slug = slugify(name) || 'tournament';
    for (let n = 2; tournaments.getTournamentBySlug(slug); n++) slug = `${slugify(name)}-${n}`;

    const created = tournaments.createTournament({
      name,
      slug,
      game: 'cs2',
      teamSize,
      maxTeams,
      bestOf: bestOfOf(body.bestOf),
      mapPool,
      publicRosters: body.publicRosters === true,
      createdBy: user.id,
    });
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'tournament-created', result: 'success',
      detail: `${name} (${created.bestOf === 1 ? 'BO1' : `BO${created.bestOf}`}, ${teamSize}v${teamSize}, max ${maxTeams} teams)`,
      ...originOf(request),
    });
    return reply.code(201).send({ tournament: describeTournament(created) });
  });

  app.get<{ Params: { id: string } }>('/api/tournaments/:id', member, async (request, reply) => {
    const tournament = findTournament(request, reply);
    if (!tournament) return reply;
    const teams = new Map(tournaments.listTeams().map((t) => [t.id, t]));
    return reply.send({
      tournament: describeTournament(tournament),
      yourOrganizer: organizes(request.user!, tournament.id),
      entries: tournaments.listEntries(tournament.id).map((e) => ({
        teamId: e.teamId,
        seed: e.seed,
        registeredAt: e.registeredAt,
        team: teams.get(e.teamId)
          ? {
              name: teams.get(e.teamId)!.name,
              captainUserId: teams.get(e.teamId)!.captainUserId,
              members: teams.get(e.teamId)!.members,
            }
          : null,
      })),
      matches: tournaments.listMatches(tournament.id).map((m) => ({
        id: m.id,
        round: m.round,
        slot: m.slot,
        teamA: m.teamA,
        teamB: m.teamB,
        scheduledAt: m.scheduledAt,
        bestOf: m.bestOf,
        status: m.status,
        maps: m.maps,
        winner: m.winner,
        forfeitTeam: m.forfeitTeam,
        overrideBy: m.overrideBy,
        // Connect info stays out of this listing on purpose: it is served to
        // the two teams through the match endpoint when the server is ready.
      })),
    });
  });

  app.put<{
    Params: { id: string };
    Body: { name?: string; teamSize?: number; maxTeams?: number; bestOf?: number; mapPool?: string[]; publicRosters?: boolean };
  }>('/api/tournaments/:id', member, async (request, reply) => {
    const user = request.user!;
    const tournament = requireOrganizer(request, reply);
    if (!tournament) return reply;
    if (tournament.status !== 'draft' && tournament.status !== 'registration') {
      return reply.code(409).send({ error: 'already-started', message: 'A running tournament cannot change shape.' });
    }
    const body = request.body ?? {};
    const mapPool = body.mapPool !== undefined ? mapsOf(body.mapPool) : tournament.mapPool;
    if (mapPool.length === 0) {
      return reply.code(400).send({ error: 'bad-map-pool', message: 'Name at least one map.' });
    }
    tournaments.updateTournament({
      id: tournament.id,
      name: String(body.name ?? tournament.name).replace(/[\r\n]/g, ' ').trim() || tournament.name,
      teamSize: Number.isInteger(Number(body.teamSize)) && Number(body.teamSize) >= 1 ? Number(body.teamSize) : tournament.teamSize,
      maxTeams: Number.isInteger(Number(body.maxTeams)) && Number(body.maxTeams) >= 2 ? Number(body.maxTeams) : tournament.maxTeams,
      bestOf: body.bestOf !== undefined ? bestOfOf(body.bestOf) : tournament.bestOf,
      mapPool,
      publicRosters: body.publicRosters !== undefined ? body.publicRosters === true : tournament.publicRosters,
    });
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'tournament-changed', result: 'success',
      detail: `${tournament.name}: settings changed`, ...originOf(request),
    });
    return reply.send({ tournament: describeTournament(tournaments.getTournament(tournament.id)!) });
  });

  app.delete<{ Params: { id: string } }>('/api/tournaments/:id', member, async (request, reply) => {
    const user = request.user!;
    const tournament = requireOrganizer(request, reply);
    if (!tournament) return reply;
    // A tournament whose matches still hold servers is not deletable: the
    // rows are what teardown works from, and orphaned containers are worse
    // than waiting one tick.
    const holding = tournaments
      .provisionedMatches()
      .filter((m) => m.tournamentId === tournament.id);
    if (holding.length > 0) {
      return reply.code(409).send({
        error: 'servers-attached',
        message: 'Match servers are still attached; wait for them to retire (a minute after their matches are decided).',
      });
    }
    tournaments.removeTournament(tournament.id);
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'tournament-removed', result: 'success',
      detail: tournament.name, ...originOf(request),
    });
    return reply.send({ ok: true });
  });

  // ---- lifecycle ---------------------------------------------------------

  app.post<{ Params: { id: string } }>('/api/tournaments/:id/open', member, async (request, reply) => {
    const tournament = requireOrganizer(request, reply);
    if (!tournament) return reply;
    if (tournament.status !== 'draft') {
      return reply.code(409).send({ error: 'wrong-status', message: 'Only a draft can open for registration.' });
    }
    tournaments.setTournamentStatus(tournament.id, 'registration');
    return reply.send({ status: 'registration' });
  });

  app.post<{ Params: { id: string } }>('/api/tournaments/:id/start', member, async (request, reply) => {
    const user = request.user!;
    const tournament = requireOrganizer(request, reply);
    if (!tournament) return reply;
    if (tournament.status !== 'registration') {
      return reply.code(409).send({ error: 'wrong-status', message: 'Open registration first; start from there.' });
    }
    try {
      tournaments.setTournamentStatus(tournament.id, 'running');
      const bracket = generateBracket(tournaments, tournament.id);
      db.audit({
        userId: user.id, username: user.username, serverId: null,
        action: 'tournament-changed', result: 'success',
        detail: `${tournament.name} started: bracket of ${bracket.filter((m) => m.round === 1).length * 2}`,
        ...originOf(request),
      });
      return reply.send({ status: 'running', matches: bracket.length });
    } catch (err) {
      // The status change is undone so a failed start leaves a startable state.
      tournaments.setTournamentStatus(tournament.id, 'registration');
      if (err instanceof BracketError) {
        return reply.code(400).send({ error: 'bracket-failed', message: err.message });
      }
      throw err;
    }
  });

  // ---- organizers, seeds, schedule ---------------------------------------

  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/api/tournaments/:id/organizers',
    member,
    async (request, reply) => {
      const tournament = requireOrganizer(request, reply);
      if (!tournament) return reply;
      const target = db.findById(String(request.body?.userId ?? ''));
      if (!target || target.disabled) return reply.code(404).send({ error: 'unknown-user' });
      // The grilled rule: an Organizer is at least an operator, always.
      if (!canOperate(target.role)) {
        return reply.code(400).send({ error: 'operator-required', message: 'Only owners and operators can organize.' });
      }
      tournaments.addOrganizer(tournament.id, target.id);
      return reply.send({ organizers: tournaments.listOrganizers(tournament.id) });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/tournaments/:id/organizers/:userId',
    member,
    async (request, reply) => {
      const tournament = requireOrganizer(request, reply);
      if (!tournament) return reply;
      const remaining = tournaments.listOrganizers(tournament.id);
      if (remaining.length === 1 && remaining[0] === request.params.userId) {
        return reply.code(409).send({ error: 'last-organizer', message: 'A tournament keeps at least one organizer.' });
      }
      tournaments.removeOrganizer(tournament.id, request.params.userId);
      return reply.send({ organizers: tournaments.listOrganizers(tournament.id) });
    },
  );

  app.put<{ Params: { id: string }; Body: { order?: string[] } }>(
    '/api/tournaments/:id/seeds',
    member,
    async (request, reply) => {
      const tournament = requireOrganizer(request, reply);
      if (!tournament) return reply;
      if (tournament.status !== 'registration') {
        return reply.code(409).send({ error: 'wrong-status', message: 'Seeding happens during registration, before the start.' });
      }
      const order = Array.isArray(request.body?.order) ? request.body.order : [];
      const entered = new Set(tournaments.listEntries(tournament.id).map((e) => e.teamId));
      if (order.length !== entered.size || !order.every((teamId) => entered.has(teamId))) {
        return reply.code(400).send({ error: 'bad-order', message: 'The order must name every registered team exactly once.' });
      }
      order.forEach((teamId, index) => tournaments.setSeed(tournament.id, teamId, index + 1));
      return reply.send({ ok: true });
    },
  );

  app.put<{ Params: { id: string; round: string }; Body: { at?: number | null } }>(
    '/api/tournaments/:id/rounds/:round/schedule',
    member,
    async (request, reply) => {
      const user = request.user!;
      const tournament = requireOrganizer(request, reply);
      if (!tournament) return reply;
      const round = Number(request.params.round);
      if (!Number.isInteger(round) || round < 1) return reply.code(400).send({ error: 'bad-round' });
      const at = request.body?.at === null ? null : Number(request.body?.at);
      if (at !== null && (!Number.isFinite(at) || at < Date.now() - 60_000)) {
        return reply.code(400).send({ error: 'bad-time', message: 'Schedule a time in the future.' });
      }
      const changed = scheduleRound(tournaments, tournament.id, round, at);
      db.audit({
        userId: user.id, username: user.username, serverId: null,
        action: 'tournament-changed', result: 'success',
        detail: `${tournament.name}: round ${round} ${at ? `scheduled for ${new Date(at).toISOString()}` : 'unscheduled'} (${changed} match(es))`,
        ...originOf(request),
      });
      return reply.send({ changed });
    },
  );

  // ---- entries ------------------------------------------------------------

  app.post<{ Params: { id: string }; Body: { teamId?: string } }>(
    '/api/tournaments/:id/register',
    member,
    async (request, reply) => {
      const user = request.user!;
      const tournament = findTournament(request, reply);
      if (!tournament) return reply;
      if (tournament.status !== 'registration') {
        return reply.code(409).send({ error: 'not-open', message: 'Registration is not open.' });
      }
      const team = tournaments.getTeam(String(request.body?.teamId ?? ''));
      if (!team) return reply.code(404).send({ error: 'unknown-team' });
      // The captain enters their team; an organizer may enter any.
      if (team.captainUserId !== user.id && !organizes(user, tournament.id)) {
        return reply.code(403).send({ error: 'captain-required', message: 'Only the captain enters a team.' });
      }
      if (team.members.length < tournament.teamSize) {
        return reply.code(400).send({
          error: 'roster-too-small',
          message: `This tournament plays ${tournament.teamSize}v${tournament.teamSize}; the roster has ${team.members.length}.`,
        });
      }
      if (tournaments.countEntries(tournament.id) >= tournament.maxTeams) {
        return reply.code(409).send({ error: 'full', message: 'The tournament is full.' });
      }
      if (tournaments.listEntries(tournament.id).some((e) => e.teamId === team.id)) {
        return reply.code(409).send({ error: 'already-registered' });
      }
      tournaments.registerEntry(tournament.id, team.id);
      const missingSteamIds = team.members.filter((m) => !m.steamId).length;
      return reply.send({
        ok: true,
        // Said now rather than discovered on match night: without Steam ids
        // the match server cannot hold these players' slots for them.
        warning:
          missingSteamIds > 0
            ? `${missingSteamIds} member(s) have no Steam ID yet; add them before the start or they cannot claim their player slots.`
            : null,
      });
    },
  );

  app.delete<{ Params: { id: string; teamId: string } }>(
    '/api/tournaments/:id/register/:teamId',
    member,
    async (request, reply) => {
      const user = request.user!;
      const tournament = findTournament(request, reply);
      if (!tournament) return reply;
      if (tournament.status !== 'registration') {
        return reply.code(409).send({ error: 'already-started', message: 'The bracket exists; withdrawing now is a forfeit, which the organizer records.' });
      }
      const team = tournaments.getTeam(request.params.teamId);
      if (!team) return reply.code(404).send({ error: 'unknown-team' });
      if (team.captainUserId !== user.id && !organizes(user, tournament.id)) {
        return reply.code(403).send({ error: 'captain-required' });
      }
      tournaments.withdrawEntry(tournament.id, team.id);
      return reply.send({ ok: true });
    },
  );

  // ---- the override -------------------------------------------------------

  app.post<{ Params: { matchId: string }; Body: { winner?: string; forfeit?: boolean; reason?: string } }>(
    '/api/tournaments/matches/:matchId/override',
    member,
    async (request, reply) => {
      const user = request.user!;
      const match = tournaments.getMatch(request.params.matchId);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });
      if (!organizes(user, match.tournamentId)) {
        return reply.code(403).send({ error: 'organizer-required' });
      }
      const reason = String(request.body?.reason ?? '').replace(/[\r\n]/g, ' ').trim();
      if (!reason) {
        return reply.code(400).send({ error: 'reason-required', message: 'An override states its reason; it ends up in the record.' });
      }
      try {
        overrideResult(tournaments, match.id, {
          winner: String(request.body?.winner ?? ''),
          forfeit: request.body?.forfeit === true,
          by: user.id,
          reason,
        });
      } catch (err) {
        if (err instanceof BracketError) {
          return reply.code(400).send({ error: 'bad-override', message: err.message });
        }
        throw err;
      }
      db.audit({
        userId: user.id, username: user.username, serverId: null,
        action: 'match-overridden', result: 'success',
        detail: `Match ${match.id.slice(0, 8)} round ${match.round}: ${request.body?.forfeit ? 'forfeit' : 'result set'} — ${reason}`,
        ...originOf(request),
      });
      // The channel hears a result the same way whether the game or the
      // organizer decided it.
      matches.announceDecision(match.id);
      return reply.send({ match: tournaments.getMatch(match.id) });
    },
  );

  // ---- teams --------------------------------------------------------------

  app.get('/api/teams', member, async (_request, reply) => {
    return reply.send({ teams: tournaments.listTeams() });
  });

  /**
   * Who can be put on a roster: id and username, nothing else. The full user
   * list stays owner-only; a captain picking teammates needs names, not
   * roles, addresses or login history.
   */
  app.get('/api/teams/people', member, async (_request, reply) => {
    return reply.send({
      people: db
        .listUsers()
        .filter((u) => !u.disabled)
        .map((u) => ({ id: u.id, username: u.username })),
    });
  });

  /**
   * How the two teams get in. Participants and organizers only, and only
   * while a server exists: the password is minted per match and dies with it.
   */
  app.get<{ Params: { matchId: string } }>(
    '/api/tournaments/matches/:matchId/connect',
    member,
    async (request, reply) => {
      const user = request.user!;
      const match = tournaments.getMatch(request.params.matchId);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });

      const playsIn = [match.teamA, match.teamB]
        .filter((id): id is string => id !== null)
        .map((id) => tournaments.getTeam(id))
        .some((team) => team?.members.some((m) => m.userId === user.id));
      if (!playsIn && !organizes(user, match.tournamentId)) {
        return reply.code(403).send({ error: 'not-your-match' });
      }
      if (!match.serverContainer || (match.status !== 'ready' && match.status !== 'live')) {
        return reply.code(409).send({ error: 'not-ready', status: match.status });
      }
      return reply.send({
        host: match.connectHost,
        port: match.connectPort,
        password: match.connectPassword,
        connect: `connect ${match.connectHost}:${match.connectPort}; password ${match.connectPassword}`,
      });
    },
  );

  app.post<{ Body: { name?: string; steamId?: string } }>('/api/teams', member, async (request, reply) => {
    const user = request.user!;
    const name = String(request.body?.name ?? '').replace(/[\r\n]/g, ' ').trim();
    if (name.length < 2 || name.length > 32) {
      return reply.code(400).send({ error: 'bad-name', message: 'Team names are 2 to 32 characters.' });
    }
    if (tournaments.findTeamByName(name)) {
      return reply.code(409).send({ error: 'name-taken', message: 'That team name is taken.' });
    }
    const steamId = /^\d{17}$/.test(String(request.body?.steamId ?? '')) ? String(request.body?.steamId) : null;
    const team = tournaments.createTeam(name, user.id, steamId);
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'team-created', result: 'success', detail: name, ...originOf(request),
    });
    return reply.code(201).send({ team });
  });

  app.post<{ Params: { id: string }; Body: { userId?: string; steamId?: string } }>(
    '/api/teams/:id/members',
    member,
    async (request, reply) => {
      const user = request.user!;
      const team = tournaments.getTeam(request.params.id);
      if (!team) return reply.code(404).send({ error: 'unknown-team' });
      if (team.captainUserId !== user.id && user.role !== 'owner') {
        return reply.code(403).send({ error: 'captain-required' });
      }
      const target = db.findById(String(request.body?.userId ?? ''));
      if (!target || target.disabled) return reply.code(404).send({ error: 'unknown-user' });
      const steamId = /^\d{17}$/.test(String(request.body?.steamId ?? '')) ? String(request.body?.steamId) : null;
      tournaments.addTeamMember(team.id, target.id, steamId);
      return reply.send({ team: tournaments.getTeam(team.id) });
    },
  );

  app.put<{ Params: { id: string; userId: string }; Body: { steamId?: string } }>(
    '/api/teams/:id/members/:userId',
    member,
    async (request, reply) => {
      const user = request.user!;
      const team = tournaments.getTeam(request.params.id);
      if (!team) return reply.code(404).send({ error: 'unknown-team' });
      // Your Steam id is yours to set; the captain can fix anyone's.
      if (request.params.userId !== user.id && team.captainUserId !== user.id && user.role !== 'owner') {
        return reply.code(403).send({ error: 'captain-required' });
      }
      const raw = String(request.body?.steamId ?? '').trim();
      if (raw && !/^\d{17}$/.test(raw)) {
        return reply.code(400).send({ error: 'bad-steam-id', message: 'A Steam ID is the 17-digit Steam64 number.' });
      }
      tournaments.setMemberSteamId(team.id, request.params.userId, raw || null);
      return reply.send({ team: tournaments.getTeam(team.id) });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/teams/:id/members/:userId',
    member,
    async (request, reply) => {
      const user = request.user!;
      const team = tournaments.getTeam(request.params.id);
      if (!team) return reply.code(404).send({ error: 'unknown-team' });
      // Leaving is yours; removing others is the captain's.
      if (request.params.userId !== user.id && team.captainUserId !== user.id && user.role !== 'owner') {
        return reply.code(403).send({ error: 'captain-required' });
      }
      if (request.params.userId === team.captainUserId) {
        return reply.code(409).send({ error: 'captain-stays', message: 'Hand the team to another captain first.' });
      }
      tournaments.removeTeamMember(team.id, request.params.userId);
      return reply.send({ team: tournaments.getTeam(team.id) });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/teams/:id', member, async (request, reply) => {
    const user = request.user!;
    const team = tournaments.getTeam(request.params.id);
    if (!team) return reply.code(404).send({ error: 'unknown-team' });
    if (team.captainUserId !== user.id && user.role !== 'owner') {
      return reply.code(403).send({ error: 'captain-required' });
    }
    const active = tournaments
      .listTournaments()
      .filter((t) => t.status === 'registration' || t.status === 'running')
      .some((t) => tournaments.listEntries(t.id).some((e) => e.teamId === team.id));
    if (active) {
      return reply.code(409).send({ error: 'team-entered', message: 'The team is entered in an open or running tournament; withdraw it first.' });
    }
    tournaments.removeTeam(team.id);
    db.audit({
      userId: user.id, username: user.username, serverId: null,
      action: 'team-removed', result: 'success', detail: team.name, ...originOf(request),
    });
    return reply.send({ ok: true });
  });

  // ---- the public tournament page (no auth at all) -------------------------

  /*
   * The shareable link: /t/<slug>. Read-only by construction — the renderer
   * is handed a PublicTournament that simply does not contain ids, connect
   * info or override details, so there is nothing here to leak. Drafts stay
   * invisible: a tournament becomes public the moment registration opens.
   */
  function publicTournament(slug: string): TournamentRow | null {
    if (!/^[a-z0-9-]{1,40}$/.test(slug)) return null;
    const tournament = tournaments.getTournamentBySlug(slug);
    return tournament && tournament.status !== 'draft' ? tournament : null;
  }

  app.get<{ Params: { slug: string } }>('/t/:slug', async (request, reply) => {
    const tournament = publicTournament(request.params.slug);
    if (!tournament) {
      return reply
        .code(404)
        .type('text/html')
        .send('<!doctype html><title>Not found</title><p style="font-family:system-ui">No such tournament.</p>');
    }
    return reply
      .type('text/html')
      .send(renderPublicPage(tournament.slug, buildPublicData(tournaments, db, tournament)));
  });

  app.get<{ Params: { slug: string } }>('/t/:slug/fragment', async (request, reply) => {
    const tournament = publicTournament(request.params.slug);
    if (!tournament) return reply.code(404).send({ error: 'unknown-tournament' });
    return reply
      .type('text/html')
      .send(renderFragment(buildPublicData(tournaments, db, tournament)));
  });

  // ---- the match server's own endpoints (token-authenticated) -------------

  const TOKEN = /^[0-9a-f]{48}$/;

  app.get<{ Params: { token: string } }>(
    '/api/tournaments/match-config/:token',
    async (request, reply) => {
      const { token } = request.params;
      if (!TOKEN.test(token)) return reply.code(404).send({ error: 'unknown-match' });
      const match = tournaments.getMatchByEventToken(token);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });
      const config = matches.buildConfigFor(match);
      if (!config) return reply.code(404).send({ error: 'unknown-match' });
      return reply.send(config);
    },
  );

  app.post<{ Body: Record<string, unknown> }>(
    '/api/tournaments/match-event',
    async (request, reply) => {
      const token = String(request.headers['x-gamekeepr-token'] ?? '');
      if (!TOKEN.test(token)) return reply.code(404).send({ error: 'unknown-match' });
      const match = tournaments.getMatchByEventToken(token);
      if (!match) return reply.code(404).send({ error: 'unknown-match' });

      const payload = request.body;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        matches.applyEvent(match, payload);
      }
      // MatchZy treats anything outside 2xx as a failed delivery and it does
      // not retry; an event we cannot use is still an event we received.
      return reply.send({ ok: true });
    },
  );
}
