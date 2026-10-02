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

  const lastRound = matches.reduce((max, m) => Math.max(max, m.round), 0);
  const final = matches.find((m) => m.round === lastRound && m.winner);

  return {
    name: tournament.name,
    status: tournament.status,
    game: tournament.game,
    teamSize: tournament.teamSize,
    bestOf: tournament.bestOf,
    mapPool: tournament.mapPool,
    startedAt: tournament.startedAt,
    finishedAt: tournament.finishedAt,
    teams,
    matches,
    champion: tournament.status === 'finished' ? (final?.winner ?? null) : null,
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
  const rounds = [...new Set(data.matches.map((m) => m.round))].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1] ?? 0;
  const roundLabel = (round: number) =>
    round === lastRound ? 'Final' : round === lastRound - 1 ? 'Semi-finals' : `Round ${round}`;

  const header = `
    <p class="meta">${data.teamSize}v${data.teamSize} · best of ${data.bestOf} · ${esc(data.mapPool.join(', '))}</p>
    ${
      data.champion
        ? `<p class="champion">🏆 ${esc(data.champion)}</p>`
        : data.status === 'registration'
          ? `<p class="meta">Registration is open — ${data.teams.length} team${data.teams.length === 1 ? '' : 's'} in.</p>`
          : ''
    }`;

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
      ? `<section><h2>Bracket</h2><div class="bracket">${rounds
          .map(
            (round) =>
              `<div class="round"><h3>${roundLabel(round)}</h3>${data.matches
                .filter((m) => m.round === round)
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

  return header + teams + bracket;
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
/* The branding layer: the later white-label feature replaces these tokens. */
:root {
  --bg: #0b0e18; --surface: #141a2b; --border: #232b42;
  --text: #e8ecf6; --muted: #9aa3bd; --accent: #e8b44c; --live: #4caf7d;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { margin: 0; font-size: 1.6rem; }
h2 { margin: 28px 0 10px; font-size: 1.05rem; }
.beta { font-size: 0.6em; color: var(--accent); text-transform: uppercase;
  letter-spacing: 0.08em; vertical-align: super; margin-left: 6px; }
.meta { color: var(--muted); margin: 6px 0; }
.champion { font-size: 1.2rem; margin: 10px 0; }
.teams { list-style: none; margin: 0; padding: 0; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.teams li { background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 14px; }
.roster { display: block; color: var(--muted); font-size: 0.85rem; }
.bracket { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 8px; }
.round { min-width: 230px; display: flex; flex-direction: column; gap: 10px; }
.round h3 { margin: 0 0 2px; font-size: 0.8rem; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted); }
.match { background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 8px 12px; }
.match.live { border-color: var(--live); }
.team { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0;
  color: var(--muted); }
.team.winner { color: var(--text); font-weight: 650; }
.score { font-variant-numeric: tabular-nums; }
.state { margin-top: 6px; font-size: 0.75rem; color: var(--muted); }
.match.live .state { color: var(--live); }
footer { margin-top: 40px; color: var(--muted); font-size: 0.85rem; }
footer a { color: inherit; }
</style>
</head>
<body>
<main>
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
