import type { Db } from '../db.js';
import type { MatchRow, TournamentRow, TournamentStore } from './store.js';

/**
 * The public face of one tournament: a read-only page anyone with the link
 * can open. It shows the competition and nothing else — team names always,
 * player names only when the organizer flipped the per-tournament switch,
 * and never ids, connect info, passwords or who overrode what.
 *
 * Branding is deliberately one layer of CSS custom properties on :root; the
 * later white-label (plus) feature fills that slot instead of refactoring
 * this page.
 */

export interface PublicMatch {
  bracket: 'wb' | 'lb' | 'gf';
  round: number;
  slot: number;
  teamA: string | null;
  teamB: string | null;
  scheduledAt: number | null;
  bestOf: number;
  /** Reduced to what a spectator needs: internals like 'provisioning' read as upcoming. */
  state: 'upcoming' | 'live' | 'decided' | 'forfeit';
  maps: Array<{ map: string; scoreA: number; scoreB: number }>;
  winner: string | null;
}

export interface PublicTournament {
  name: string;
  status: TournamentRow['status'];
  format: TournamentRow['format'];
  game: string;
  teamSize: number;
  bestOf: number;
  mapPool: string[];
  startedAt: number | null;
  finishedAt: number | null;
  teams: Array<{ name: string; seed: number | null; roster: string[] | null }>;
  matches: PublicMatch[];
  champion: string | null;
  beta: true;
}

export interface StandingRow {
  team: string;
  played: number;
  wins: number;
  losses: number;
  mapsWon: number;
  mapsLost: number;
  roundDiff: number;
}

/**
 * The leaderboard, derived from nothing but the matches: wins first, then map
 * difference, then round difference. Only settled matches count — a live
 * score is news, not a standing.
 */
export function computeStandings(
  teams: Array<{ name: string }>,
  matches: PublicMatch[],
): StandingRow[] {
  const rows = new Map<string, StandingRow>(
    teams.map((t) => [
      t.name,
      { team: t.name, played: 0, wins: 0, losses: 0, mapsWon: 0, mapsLost: 0, roundDiff: 0 },
    ]),
  );
  for (const match of matches) {
    if (match.state !== 'decided' && match.state !== 'forfeit') continue;
    if (!match.teamA || !match.teamB || !match.winner) continue;
    const a = rows.get(match.teamA);
    const b = rows.get(match.teamB);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    (match.winner === match.teamA ? a : b).wins++;
    (match.winner === match.teamA ? b : a).losses++;
    for (const map of match.maps) {
      if (map.scoreA > map.scoreB) (a.mapsWon++, b.mapsLost++);
      else if (map.scoreB > map.scoreA) (b.mapsWon++, a.mapsLost++);
      a.roundDiff += map.scoreA - map.scoreB;
      b.roundDiff += map.scoreB - map.scoreA;
    }
  }
  return [...rows.values()].sort(
    (x, y) =>
      y.wins - x.wins ||
      y.mapsWon - y.mapsLost - (x.mapsWon - x.mapsLost) ||
      y.roundDiff - x.roundDiff ||
      x.team.localeCompare(y.team),
  );
}

const publicState = (match: MatchRow): PublicMatch['state'] => {
  if (match.status === 'decided') return 'decided';
  if (match.status === 'forfeit') return 'forfeit';
  if (match.status === 'live') return 'live';
  return 'upcoming';
};

export function buildPublicData(
  store: TournamentStore,
  db: Pick<Db, 'findById'>,
  tournament: TournamentRow,
): PublicTournament {
  const entries = store.listEntries(tournament.id);
  const teamNames = new Map<string, string>();
  const teams = entries.map((entry) => {
    const team = store.getTeam(entry.teamId);
    const name = team?.name ?? 'Unknown team';
    teamNames.set(entry.teamId, name);
    return {
      name,
      seed: entry.seed,
      // Usernames, never ids — and only behind the per-tournament switch.
      roster:
        tournament.publicRosters && team
          ? team.members.map((m) => db.findById(m.userId)?.username ?? '?')
          : null,
    };
  });

  const matches = store.listMatches(tournament.id).map((match) => ({
    bracket: match.bracket,
    round: match.round,
    slot: match.slot,
    teamA: match.teamA ? (teamNames.get(match.teamA) ?? null) : null,
    teamB: match.teamB ? (teamNames.get(match.teamB) ?? null) : null,
    scheduledAt: match.scheduledAt,
    bestOf: match.bestOf,
    state: publicState(match),
    maps: match.maps,
    winner: match.winner ? (teamNames.get(match.winner) ?? null) : null,
  }));

  // Who won depends on the format: the last bracket round, the grand final,
  // or — for round robin — the top of the standings once everything is played.
  const champion = (() => {
    if (tournament.status !== 'finished') return null;
    if (tournament.format === 'double') {
      return matches.find((m) => m.bracket === 'gf')?.winner ?? null;
    }
    if (tournament.format === 'roundrobin') {
      return computeStandings(teams, matches)[0]?.team ?? null;
    }
    const lastRound = matches.reduce((max, m) => Math.max(max, m.round), 0);
    return matches.find((m) => m.bracket === 'wb' && m.round === lastRound && m.winner)?.winner ?? null;
  })();

  return {
    name: tournament.name,
    status: tournament.status,
    format: tournament.format,
    game: tournament.game,
    teamSize: tournament.teamSize,
    bestOf: tournament.bestOf,
    mapPool: tournament.mapPool,
    startedAt: tournament.startedAt,
    finishedAt: tournament.finishedAt,
    teams,
    matches,
    champion,
    beta: true,
  };
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const when = (ts: number | null): string =>
  ts
    ? new Date(ts).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

/** The page's dynamic middle; re-rendered by the page's own refresh script. */
export function renderFragment(data: PublicTournament): string {
  // One column per (bracket, round), in play order: the store already sorts
  // winners before losers before the grand final.
  const columns: Array<{ bracket: PublicMatch['bracket']; round: number }> = [];
  for (const m of data.matches) {
    if (!columns.some((c) => c.bracket === m.bracket && c.round === m.round)) {
      columns.push({ bracket: m.bracket, round: m.round });
    }
  }
  const lastOf = (bracket: PublicMatch['bracket']) =>
    Math.max(0, ...data.matches.filter((m) => m.bracket === bracket).map((m) => m.round));
  const roundLabel = (bracket: PublicMatch['bracket'], round: number): string => {
    if (bracket === 'gf') return 'Grand final';
    if (data.format === 'roundrobin') return `Round ${round}`;
    if (data.format === 'double') {
      const side = bracket === 'wb' ? 'Winners' : 'Losers';
      return round === lastOf(bracket) ? `${side} final` : `${side} round ${round}`;
    }
    const last = lastOf('wb');
    return round === last ? 'Final' : round === last - 1 ? 'Semi-finals' : `Round ${round}`;
  };

  const header = `
    <p class="meta">${data.teamSize}v${data.teamSize} · best of ${data.bestOf} · ${esc(data.mapPool.join(', '))}</p>
    ${
      data.champion
        ? `<p class="champion">🏆 ${esc(data.champion)}</p>`
        : data.status === 'registration'
          ? `<p class="meta">Registration is open — ${data.teams.length} team${data.teams.length === 1 ? '' : 's'} in.</p>`
          : ''
    }`;

  const standings = computeStandings(data.teams, data.matches);
  const leaderboard =
    standings.some((row) => row.played > 0)
      ? `<section><h2>Standings</h2><table class="standings">
          <thead><tr><th></th><th>Team</th><th>W</th><th>L</th><th>Maps</th><th>Rounds ±</th></tr></thead>
          <tbody>${standings
            .map(
              (row, index) =>
                `<tr${data.champion === row.team ? ' class="top"' : ''}>
                   <td class="pos">${index + 1}</td>
                   <td>${data.champion === row.team ? '🏆 ' : ''}${esc(row.team)}</td>
                   <td>${row.wins}</td><td>${row.losses}</td>
                   <td>${row.mapsWon}–${row.mapsLost}</td>
                   <td>${row.roundDiff > 0 ? '+' : ''}${row.roundDiff}</td>
                 </tr>`,
            )
            .join('')}</tbody></table></section>`
      : '';

  const teams =
    data.teams.length > 0
      ? `<section><h2>Teams</h2><ul class="teams">${data.teams
          .map(
            (team) =>
              `<li><strong>${team.seed ? `${team.seed}. ` : ''}${esc(team.name)}</strong>${
                team.roster ? `<span class="roster">${team.roster.map(esc).join(', ')}</span>` : ''
              }</li>`,
          )
          .join('')}</ul></section>`
      : '';

  const bracket =
    data.matches.length > 0
      ? `<section><h2>${data.format === 'roundrobin' ? 'Rounds' : 'Bracket'}</h2><div class="bracket">${columns
          .map(
            (column) =>
              `<div class="round"><h3>${roundLabel(column.bracket, column.round)}</h3>${data.matches
                .filter((m) => m.bracket === column.bracket && m.round === column.round)
                .map((match) => {
                  const score = (side: 'scoreA' | 'scoreB') =>
                    match.maps.map((m) => m[side]).join(' · ');
                  const team = (name: string | null, side: 'scoreA' | 'scoreB') =>
                    `<div class="team${match.winner !== null && match.winner === name ? ' winner' : ''}">
                       <span>${name ? esc(name) : '—'}</span><span class="score">${score(side)}</span>
                     </div>`;
                  return `<div class="match ${match.state}">${team(match.teamA, 'scoreA')}${team(match.teamB, 'scoreB')}
                    <div class="state">${
                      match.state === 'live'
                        ? '● live'
                        : match.state === 'forfeit'
                          ? 'forfeit'
                          : match.state === 'decided'
                            ? 'decided'
                            : match.scheduledAt
                              ? esc(when(match.scheduledAt))
                              : 'to be scheduled'
                    }</div></div>`;
                })
                .join('')}</div>`,
          )
          .join('')}</div></section>`
      : '';

  return header + leaderboard + bracket + teams;
}

/** The whole page: shell, theme slot, and a refresh loop while play is on. */
export function renderPublicPage(slug: string, data: PublicTournament): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="robots" content="noindex" />
<title>${esc(data.name)} — GameKeepr</title>
<style>
/*
 * The portal's own look, token for token, so the public page is unmistakably
 * the same product -- and the branding stays one swappable layer: the later
 * white-label feature replaces these tokens and the brand row, nothing else.
 */
:root {
  --bg: #090e1c; --surface: #121a30; --surface-2: #1a2440;
  --border: #273252; --border-soft: #1d2740;
  --text: #eef1f8; --muted: #9aa5c4; --faint: #6b779c;
  --accent: #7c6cf2; --accent-cyan: #49c9f7;
  --ok: #4ade80; --gold: #e8b44c; --radius: 16px;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text); min-height: 100vh;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* The portal's grid backdrop: hairlines fading out, plus a soft glow. */
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1;
  background:
    radial-gradient(900px 480px at 75% -10%, rgba(124, 108, 242, 0.14), transparent 65%),
    radial-gradient(700px 420px at 15% 0%, rgba(73, 201, 247, 0.07), transparent 60%),
    repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 44px),
    repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 44px);
  mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
}
main { max-width: 1020px; margin: 0 auto; padding: 22px 20px 60px; }
.brand {
  display: flex; align-items: center; gap: 10px; margin-bottom: 26px;
  color: var(--muted); font-weight: 650; font-size: 0.95rem;
}
.brand img { width: 26px; height: 26px; }
h1 { margin: 0; font-size: 1.7rem; letter-spacing: -0.01em; }
h2 { margin: 30px 0 10px; font-size: 1.02rem; }
.beta { font-size: 0.55em; color: var(--gold); text-transform: uppercase;
  letter-spacing: 0.08em; vertical-align: super; margin-left: 7px; font-weight: 700; }
.meta { color: var(--muted); margin: 6px 0 0; }
.champion { font-size: 1.15rem; margin: 12px 0 0; }
.standings { width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--border-soft); border-radius: var(--radius); overflow: hidden; }
.standings th, .standings td { padding: 9px 14px; text-align: left; }
.standings th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--faint); border-bottom: 1px solid var(--border-soft); font-weight: 650; }
.standings td { border-bottom: 1px solid var(--border-soft);
  font-variant-numeric: tabular-nums; color: var(--muted); }
.standings td:nth-child(2) { color: var(--text); font-weight: 600; }
.standings tr:last-child td { border-bottom: none; }
.standings tr.top td { background: rgba(232, 180, 76, 0.07); }
.standings .pos { color: var(--faint); width: 30px; }
.teams { list-style: none; margin: 0; padding: 0; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.teams li { background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: 12px; padding: 11px 15px; }
.roster { display: block; color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
.bracket { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 8px; }
.round { min-width: 235px; display: flex; flex-direction: column; gap: 10px; }
.round h3 { margin: 0 0 2px; font-size: 0.74rem; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--faint); }
.match { background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: 12px; padding: 9px 13px; }
.match.live { border-color: var(--ok); box-shadow: 0 0 0 1px rgba(74, 222, 128, 0.25); }
.team { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0;
  color: var(--muted); }
.team.winner { color: var(--text); font-weight: 650; }
.score { font-variant-numeric: tabular-nums; }
.state { margin-top: 6px; font-size: 0.74rem; color: var(--faint); }
.match.live .state { color: var(--ok); }
footer { margin-top: 44px; color: var(--faint); font-size: 0.84rem;
  border-top: 1px solid var(--border-soft); padding-top: 16px; }
footer a { color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="brand"><img src="/logo.png" alt="" width="26" height="26" /> GameKeepr</div>
  <h1>${esc(data.name)}<sup class="beta">beta</sup></h1>
  <div id="live">${renderFragment(data)}</div>
  <footer>Run with <a href="https://kengoossens.github.io/Gamekeep/" rel="noreferrer">GameKeepr</a>,
  the self-hosted game server portal.</footer>
</main>
<script>
// While there is play to follow, the page keeps itself fresh. The server
// renders; this only swaps the middle, so the page works fine without it.
(function () {
  var running = ${JSON.stringify(data.status === 'running' || data.status === 'registration')};
  if (!running) return;
  setInterval(function () {
    fetch('/t/${encodeURIComponent(slug)}/fragment')
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) { if (html) document.getElementById('live').innerHTML = html; })
      .catch(function () {});
  }, 15000);
})();
</script>
</body>
</html>`;
}
