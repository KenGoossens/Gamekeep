import type { BestOf, BracketSide, MatchRow, TournamentStore } from './store.js';

/**
 * The tournament's arithmetic, for three formats:
 *
 * - single elimination ('bracket'): lose once, go home;
 * - double elimination ('double'): a winners bracket, a losers bracket that
 *   catches every first loss, and a grand final between the two survivors
 *   (played as one series — no bracket reset, said in the wiki);
 * - round robin ('roundrobin'): everyone plays everyone, the standings crown
 *   the champion.
 *
 * The engine is declarative: every match's two sides are either seeded or
 * FED by another match (take its winner, or take its loser). settle() is a
 * fixpoint over that graph — place what is known, decide byes (a side whose
 * feeder can never produce a team), repeat until nothing moves, then notice
 * the end. Everything else (override, forfeits, late webhooks) simply calls
 * settle() after changing a result; the graph never needs to know why.
 */

export class BracketError extends Error {}

/** Where one side of a match comes from. */
type Feeder =
  | { kind: 'seed' }
  | { kind: 'take'; bracket: BracketSide; round: number; slot: number; take: 'winner' | 'loser' };

/**
 * Classic tournament seed placement for a bracket of `size` (a power of two):
 * seed 1 and seed 2 land in opposite halves, so the best two teams can only
 * meet in the final. Built by the textbook expansion: [1] -> [1,2] ->
 * [1,4,2,3] -> [1,8,4,5,2,7,3,6] -> ...
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((seed) => [seed, doubled + 1 - seed]);
  }
  return order;
}

const bracketSizeFor = (teams: number): number => {
  let size = 2;
  while (size < teams) size *= 2;
  return size;
};

const key = (bracket: BracketSide, round: number, slot: number) => `${bracket}:${round}:${slot}`;

/**
 * The feeder graph for one match position. Single elimination feeds winners
 * up its own bracket; double elimination adds the standard losers-bracket
 * weave: winners-round-1 losers pair up, every later winners round drops its
 * losers onto the losers bracket's even rounds, odd losers rounds pair the
 * survivors back down. Round robin feeds nothing — every match is seeded.
 */
function feedersOf(
  format: string,
  size: number,
  match: Pick<MatchRow, 'bracket' | 'round' | 'slot'>,
): { a: Feeder; b: Feeder } {
  const { bracket, round, slot } = match;
  if (format === 'roundrobin') return { a: { kind: 'seed' }, b: { kind: 'seed' } };

  if (bracket === 'wb') {
    if (round === 1) return { a: { kind: 'seed' }, b: { kind: 'seed' } };
    return {
      a: { kind: 'take', bracket: 'wb', round: round - 1, slot: slot * 2, take: 'winner' },
      b: { kind: 'take', bracket: 'wb', round: round - 1, slot: slot * 2 + 1, take: 'winner' },
    };
  }

  const k = Math.log2(size);
  if (bracket === 'gf') {
    return {
      a: { kind: 'take', bracket: 'wb', round: k, slot: 0, take: 'winner' },
      b: { kind: 'take', bracket: 'lb', round: 2 * (k - 1), slot: 0, take: 'winner' },
    };
  }

  // Losers bracket.
  if (round === 1) {
    return {
      a: { kind: 'take', bracket: 'wb', round: 1, slot: slot * 2, take: 'loser' },
      b: { kind: 'take', bracket: 'wb', round: 1, slot: slot * 2 + 1, take: 'loser' },
    };
  }
  if (round % 2 === 0) {
    // A drop-in round: the losers-bracket survivor meets the fresh dropper
    // from the winners bracket — from the MIRRORED slot, the convention that
    // keeps "A beat B in round one, B fights back, meets A again immediately"
    // from being a coin-flip certainty.
    const wbRound = round / 2 + 1;
    const wbCount = size / 2 ** wbRound;
    return {
      a: { kind: 'take', bracket: 'lb', round: round - 1, slot, take: 'winner' },
      b: { kind: 'take', bracket: 'wb', round: wbRound, slot: wbCount - 1 - slot, take: 'loser' },
    };
  }
  // An odd (pairing) round: losers-bracket winners pair among themselves.
  return {
    a: { kind: 'take', bracket: 'lb', round: round - 1, slot: slot * 2, take: 'winner' },
    b: { kind: 'take', bracket: 'lb', round: round - 1, slot: slot * 2 + 1, take: 'winner' },
  };
}

/** How many matches each (bracket, round) holds for a double bracket of size N. */
function doubleLayout(size: number): Array<{ bracket: BracketSide; round: number; count: number }> {
  const k = Math.log2(size);
  const layout: Array<{ bracket: BracketSide; round: number; count: number }> = [];
  for (let r = 1; r <= k; r++) layout.push({ bracket: 'wb', round: r, count: size / 2 ** r });
  for (let r = 1; r <= 2 * (k - 1); r++) {
    const m = Math.ceil(r / 2);
    layout.push({ bracket: 'lb', round: r, count: size / 2 ** (m + 1) });
  }
  layout.push({ bracket: 'gf', round: 1, count: 1 });
  return layout;
}

/** Everyone meets everyone once: the classic circle method. */
function roundRobinPairings(teamIds: Array<string>): Array<Array<[string, string]>> {
  const ring: Array<string | null> = [...teamIds];
  if (ring.length % 2 === 1) ring.push(null);
  const n = ring.length;
  const rounds: Array<Array<[string, string]>> = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < n / 2; i++) {
      const home = ring[i]!;
      const away = ring[n - 1 - i]!;
      if (home !== null && away !== null) pairs.push([home, away]);
    }
    rounds.push(pairs);
    // Rotate everyone but the first seat.
    ring.splice(1, 0, ring.pop()!);
  }
  return rounds;
}

/**
 * Turns a tournament's entries into its matches, per its format. Seeds are
 * honoured where the organizer set them; unseeded entries draw random
 * positions below the seeded ones.
 */
export function generateBracket(store: TournamentStore, tournamentId: string): MatchRow[] {
  const tournament = store.getTournament(tournamentId);
  if (!tournament) throw new BracketError('No such tournament.');
  if (store.listMatches(tournamentId).length > 0) {
    throw new BracketError('This tournament already has a bracket.');
  }

  const entries = store.listEntries(tournamentId);
  if (entries.length < 2) {
    throw new BracketError('A bracket needs at least two teams.');
  }
  if (tournament.format === 'double' && entries.length < 3) {
    throw new BracketError('Double elimination needs at least three teams — with two, just play a series.');
  }

  const seeded = entries.filter((e) => e.seed !== null).sort((a, b) => a.seed! - b.seed!);
  const unseeded = entries
    .filter((e) => e.seed === null)
    .map((e) => ({ e, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map(({ e }) => e);
  const ordered = [...seeded, ...unseeded];
  ordered.forEach((entry, index) => store.setSeed(tournamentId, entry.teamId, index + 1));

  const bestOf = tournament.bestOf as BestOf;

  if (tournament.format === 'roundrobin') {
    roundRobinPairings(ordered.map((e) => e.teamId)).forEach((pairs, roundIndex) => {
      pairs.forEach(([teamA, teamB], slot) => {
        store.addMatch({ tournamentId, bracket: 'wb', round: roundIndex + 1, slot, teamA, teamB, bestOf });
      });
    });
    return store.listMatches(tournamentId);
  }

  const size = bracketSizeFor(ordered.length);
  const placement = seedOrder(size);

  // Winners round 1 from the placement; byes decided on the spot.
  for (let slot = 0; slot < size / 2; slot++) {
    const a = ordered[placement[slot * 2]! - 1];
    const b = ordered[placement[slot * 2 + 1]! - 1];
    store.addMatch({
      tournamentId,
      bracket: 'wb',
      round: 1,
      slot,
      teamA: a?.teamId ?? null,
      teamB: b?.teamId ?? null,
      bestOf,
      decidedWinner: a && !b ? a.teamId : undefined,
    });
  }

  const layout =
    tournament.format === 'double'
      ? doubleLayout(size).filter((row) => !(row.bracket === 'wb' && row.round === 1))
      : Array.from({ length: Math.log2(size) - 1 }, (_, i) => ({
          bracket: 'wb' as BracketSide,
          round: i + 2,
          count: size / 2 ** (i + 2),
        }));
  for (const row of layout) {
    for (let slot = 0; slot < row.count; slot++) {
      store.addMatch({ tournamentId, bracket: row.bracket, round: row.round, slot, teamA: null, teamB: null, bestOf });
    }
  }

  settle(store, tournamentId);
  return store.listMatches(tournamentId);
}

/**
 * The fixpoint: place every team the graph already knows, decide byes, and
 * notice the end. Idempotent; refusal-happy about anything live: a match
 * that is decided, holds a server, or has started is never rewritten —
 * correcting those is organizer-override work on that match itself.
 */
export function settle(store: TournamentStore, tournamentId: string): void {
  const tournament = store.getTournament(tournamentId);
  if (!tournament) return;
  const format = tournament.format;

  for (let pass = 0; pass < 32; pass++) {
    const matches = store.listMatches(tournamentId);
    const byKey = new Map(matches.map((m) => [key(m.bracket, m.round, m.slot), m]));
    const size = 2 * (matches.filter((m) => m.bracket === 'wb' && m.round === 1).length || 1);

    /** A side's current truth: a team, VOID (never coming), or UNKNOWN. */
    const resolve = (feeder: Feeder, current: string | null): string | null | 'unknown' => {
      if (feeder.kind === 'seed') return current; // placed at generation
      const source = byKey.get(key(feeder.bracket, feeder.round, feeder.slot));
      if (!source) return 'unknown';
      if (source.status !== 'decided' && source.status !== 'forfeit') {
        // An undecided source whose own sides are both void can never decide;
        // treat a fully-empty pending source as void-producing.
        if (source.teamA === null && source.teamB === null && sourceIsVoid(source)) return null;
        return 'unknown';
      }
      if (feeder.take === 'winner') return source.winner;
      // The loser — which a bye never produced.
      if (source.teamA === null || source.teamB === null) return null;
      return source.winner === source.teamA ? source.teamB : source.teamA;
    };

    /** True when a pending, empty match can never receive teams. */
    const sourceIsVoid = (m: MatchRow): boolean => {
      const feeders = feedersOf(format, size, m);
      const a = feeders.a.kind === 'take' ? resolve(feeders.a, null) : m.teamA;
      const b = feeders.b.kind === 'take' ? resolve(feeders.b, null) : m.teamB;
      return a === null && b === null;
    };

    /**
     * An automatic bye decision — never played, never overridden — may be
     * re-derived when an upstream override changed who should have received
     * it. Everything with a real result (maps, a server, an organizer's
     * word) stays untouchable.
     */
    const isAutoBye = (m: MatchRow): boolean =>
      m.status === 'decided' &&
      !m.serverContainer &&
      !m.overrideBy &&
      m.maps.length === 0 &&
      (m.teamA === null || m.teamB === null);

    let changed = false;
    for (const match of matches) {
      const revisitableBye = isAutoBye(match);
      // Live or genuinely settled matches are never rewritten by the graph.
      if ((match.status !== 'pending' && !revisitableBye) || match.serverContainer) continue;

      const feeders = feedersOf(format, size, match);
      const a = feeders.a.kind === 'take' ? resolve(feeders.a, match.teamA) : match.teamA;
      const b = feeders.b.kind === 'take' ? resolve(feeders.b, match.teamB) : match.teamB;

      const nextA = a === 'unknown' ? match.teamA : a;
      const nextB = b === 'unknown' ? match.teamB : b;
      if (nextA !== match.teamA || nextB !== match.teamB) {
        // A bye whose sides no longer hold is reopened and re-derived; a
        // pending match simply gets its sides updated.
        if (revisitableBye) store.reopenMatch(match.id);
        store.setMatchTeams(match.id, nextA, nextB);
        changed = true;
      } else if (revisitableBye) {
        // Sides unchanged: the bye stands exactly as derived; nothing to do.
        continue;
      }

      // A bye: one side present, the other provably never coming.
      if (nextA && b === null) {
        store.decideMatch({ id: match.id, status: 'decided', winner: nextA });
        changed = true;
      } else if (nextB && a === null) {
        store.decideMatch({ id: match.id, status: 'decided', winner: nextB });
        changed = true;
      }
    }
    if (!changed) break;
  }

  // The end, per format.
  if (tournament.status !== 'running') return;
  const matches = store.listMatches(tournamentId);
  const finished =
    format === 'roundrobin'
      ? matches.every((m) => m.status === 'decided' || m.status === 'forfeit')
      : format === 'double'
        ? (matches.find((m) => m.bracket === 'gf')?.winner ?? null) !== null
        : (() => {
            const lastRound = Math.max(...matches.map((m) => m.round));
            return (matches.find((m) => m.bracket === 'wb' && m.round === lastRound)?.winner ?? null) !== null;
          })();
  if (finished) store.setTournamentStatus(tournamentId, 'finished');
}

/** Kept as the name callers know: a result changed, re-settle the graph. */
export function advanceFrom(store: TournamentStore, matchId: string): void {
  const match = store.getMatch(matchId);
  if (match) settle(store, match.tournamentId);
}

/**
 * The one correction path: the organizer names a winner, whatever the game
 * said or failed to say. Also how a no-show becomes a forfeit.
 */
export function overrideResult(
  store: TournamentStore,
  matchId: string,
  verdict: {
    winner: string;
    forfeit?: boolean;
    by: string;
    reason: string;
  },
): void {
  const match = store.getMatch(matchId);
  if (!match) throw new BracketError('No such match.');
  if (!match.teamA || !match.teamB || ![match.teamA, match.teamB].includes(verdict.winner)) {
    throw new BracketError('The winner must be one of the two teams in the match.');
  }
  store.decideMatch({
    id: matchId,
    status: verdict.forfeit ? 'forfeit' : 'decided',
    winner: verdict.winner,
    forfeitTeam: verdict.forfeit
      ? verdict.winner === match.teamA
        ? match.teamB
        : match.teamA
      : null,
    overrideBy: verdict.by,
    overrideReason: verdict.reason,
  });
  settle(store, match.tournamentId);
}

/** Sets one round's play time; matches already holding a server keep theirs. */
export function scheduleRound(
  store: TournamentStore,
  tournamentId: string,
  bracket: BracketSide,
  round: number,
  at: number | null,
): number {
  let changed = 0;
  for (const match of store.listMatches(tournamentId)) {
    if (match.bracket !== bracket || match.round !== round || match.serverContainer) continue;
    if (match.status === 'decided' || match.status === 'forfeit') continue;
    store.scheduleMatch(match.id, at);
    changed++;
  }
  return changed;
}
