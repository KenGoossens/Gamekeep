import type { BestOf, MatchRow, TournamentStore } from './store.js';

/**
 * The bracket's arithmetic: who plays whom, where winners go, when it ends.
 *
 * Everything here is a pure consequence of two numbers — a match's (round,
 * slot) — so none of it talks to Docker or Steam. The winner of (r, s) feeds
 * (r+1, s>>1), sitting left when s is even and right when it is odd; the
 * final is the single match in the highest round. Byes are decided at
 * generation time, so "no opponent" never exists as a state anything later
 * has to understand.
 */

export class BracketError extends Error {}

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

/**
 * Turns a tournament's entries into its bracket.
 *
 * Seeds are honoured where the organizer set them; everyone else draws a
 * random position below the seeded ones. Uneven fields get byes: the top
 * seeds' round-1 matches are created already decided, and their winners are
 * advanced immediately, so a 6-team bracket opens with two real matches and
 * two teams already standing in round 2.
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

  // Seeded entries first in seed order, then the unseeded in random order --
  // a fresh array each time, so regenerating after a withdrawal reshuffles.
  const seeded = entries.filter((e) => e.seed !== null).sort((a, b) => a.seed! - b.seed!);
  const unseeded = entries
    .filter((e) => e.seed === null)
    .map((e) => ({ e, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map(({ e }) => e);
  const ordered = [...seeded, ...unseeded];
  ordered.forEach((entry, index) => store.setSeed(tournamentId, entry.teamId, index + 1));

  const size = bracketSizeFor(ordered.length);
  const placement = seedOrder(size);
  const bestOf = tournament.bestOf as BestOf;
  const rounds = Math.log2(size);
  const created: MatchRow[] = [];

  // Round 1 from the placement; every later round as empty slots, so the
  // whole bracket is visible (and schedulable) from the start.
  for (let slot = 0; slot < size / 2; slot++) {
    const a = ordered[placement[slot * 2]! - 1];
    const b = ordered[placement[slot * 2 + 1]! - 1];
    created.push(
      store.addMatch({
        tournamentId,
        round: 1,
        slot,
        teamA: a?.teamId ?? null,
        teamB: b?.teamId ?? null,
        bestOf,
        // A missing opponent is a bye, decided here and never seen again.
        decidedWinner: a && !b ? a.teamId : undefined,
      }),
    );
  }
  for (let round = 2; round <= rounds; round++) {
    for (let slot = 0; slot < size / 2 ** round; slot++) {
      created.push(store.addMatch({ tournamentId, round, slot, teamA: null, teamB: null, bestOf }));
    }
  }

  // Walk the byes forward so round 2 shows who is waiting there.
  for (const match of created) {
    if (match.status === 'decided') advanceFrom(store, match.id);
  }
  return store.listMatches(tournamentId);
}

/**
 * Carries one decided match's winner into the next round, and notices when
 * the tournament is over. Idempotent and refusal-happy: a next match that is
 * already provisioned, live or decided is never rewritten -- correcting that
 * far back is organizer-override work on that match itself, not something a
 * late webhook event gets to do by side effect.
 */
export function advanceFrom(store: TournamentStore, matchId: string): void {
  const match = store.getMatch(matchId);
  if (!match || !match.winner) return;

  const tournament = store.getTournament(match.tournamentId);
  if (!tournament) return;

  const all = store.listMatches(match.tournamentId);
  const lastRound = Math.max(...all.map((m) => m.round));

  if (match.round === lastRound) {
    // The final: a winner here ends the tournament.
    if (tournament.status === 'running') store.setTournamentStatus(match.tournamentId, 'finished');
    return;
  }

  const next = all.find((m) => m.round === match.round + 1 && m.slot === match.slot >> 1);
  if (!next) return;
  if (next.status !== 'pending' || next.serverContainer) return;

  const side: 'teamA' | 'teamB' = match.slot % 2 === 0 ? 'teamA' : 'teamB';
  if (next[side] === match.winner) return;
  store.setMatchTeams(
    next.id,
    side === 'teamA' ? match.winner : next.teamA,
    side === 'teamB' ? match.winner : next.teamB,
  );
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
  advanceFrom(store, matchId);
}

/** Sets one round's play time; matches already holding a server keep theirs. */
export function scheduleRound(
  store: TournamentStore,
  tournamentId: string,
  round: number,
  at: number | null,
): number {
  let changed = 0;
  for (const match of store.listMatches(tournamentId)) {
    if (match.round !== round || match.serverContainer) continue;
    if (match.status === 'decided' || match.status === 'forfeit') continue;
    store.scheduleMatch(match.id, at);
    changed++;
  }
  return changed;
}
