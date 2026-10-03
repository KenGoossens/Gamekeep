import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  type Me,
  type TeamInfo,
  type TournamentDetail,
  type TournamentMatch,
} from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { linkProps, navigate } from '../router.ts';

const explain = (err: unknown, fallback: string): string =>
  err instanceof ApiError && typeof err.body.message === 'string' ? err.body.message : fallback;

const MATCH_STATUS: Record<TournamentMatch['status'], string> = {
  pending: 'waiting',
  provisioning: 'building server…',
  ready: 'server ready — join now',
  live: 'live',
  decided: 'decided',
  forfeit: 'forfeit',
};

/** One tournament: its entries while open, its bracket once running. */
export function TournamentDetailPage({ id, me }: { id: string; me: Me }) {
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [override, setOverride] = useState<TournamentMatch | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api.tournament(id), api.teams()]);
      setDetail(d);
      setTeams(t.teams);
    } catch {
      setError('Could not load this tournament.');
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Live enough for match night without a socket: the bracket is small.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const teamName = useMemo(() => {
    const names = new Map<string, string>();
    for (const team of teams) names.set(team.id, team.name);
    for (const entry of detail?.entries ?? []) {
      if (entry.team) names.set(entry.teamId, entry.team.name);
    }
    return (teamId: string | null) => (teamId ? (names.get(teamId) ?? '…') : null);
  }, [teams, detail]);

  if (!detail) return <p className="empty">{error ?? 'Loading…'}</p>;
  const { tournament, yourOrganizer, entries, matches } = detail;

  const act = async (run: () => Promise<unknown>, failure: string) => {
    setError(null);
    setNote(null);
    try {
      await run();
      await load();
    } catch (err) {
      setError(explain(err, failure));
    }
  };

  return (
    <>
      <a {...linkProps('/tournaments')} className="backlink">
        ← All tournaments
      </a>

      <div className="page-head command-head">
        <div>
          <h1>
            {tournament.name} <sup className="beta-tag">beta</sup>
          </h1>
          <p>
            {tournament.teamSize}v{tournament.teamSize} · BO{tournament.bestOf} · map pool:{' '}
            {tournament.mapPool.join(', ')} · {tournament.status}
            {tournament.status !== 'draft' ? (
              <>
                {' · '}
                {/* The shareable, no-login view — hand this to spectators. */}
                <a href={`/t/${encodeURIComponent(tournament.slug)}`} target="_blank" rel="noreferrer">
                  public page ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
        {yourOrganizer ? (
          <div className="actions">
            {tournament.status === 'draft' ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void act(() => api.openTournament(tournament.id), 'Could not open it.')}
              >
                Open registration
              </button>
            ) : null}
            {tournament.status === 'registration' ? (
              <button
                type="button"
                className="btn-primary"
                disabled={entries.length < 2}
                onClick={() =>
                  void act(() => api.startTournament(tournament.id), 'Could not start it.')
                }
              >
                Start — build the bracket
              </button>
            ) : null}
            <button
              type="button"
              className="btn-ghost danger"
              onClick={() => {
                if (!confirm(`Delete ${tournament.name}? The teams stay; the bracket is gone.`)) return;
                void act(async () => {
                  await api.deleteTournament(tournament.id);
                  navigate('/tournaments');
                }, 'Could not delete it.');
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>

      {error ? <p className="hint bad">{error}</p> : null}
      {note ? <p className="hint ok">{note}</p> : null}

      {tournament.status === 'draft' ? (
        <p className="empty">
          A draft: only organizers see it does anything. Open registration to let captains enter.
        </p>
      ) : null}

      {tournament.status === 'registration' ? (
        <Registration
          detail={detail}
          me={me}
          teams={teams}
          teamName={teamName}
          onError={setError}
          onNote={setNote}
          onChanged={() => void load()}
        />
      ) : null}

      {matches.length > 0 ? <Standings matches={matches} teamName={teamName} /> : null}

      {matches.length > 0 ? (
        <Bracket
          matches={matches}
          teamName={teamName}
          me={me}
          teams={teams}
          yourOrganizer={yourOrganizer}
          tournamentId={tournament.id}
          finished={tournament.status === 'finished'}
          onSchedule={(round, at) =>
            void act(
              () => api.scheduleTournamentRound(tournament.id, round, at),
              'Could not schedule the round.',
            )
          }
          onOverride={setOverride}
        />
      ) : null}

      {override ? (
        <OverrideDialog
          match={override}
          teamName={teamName}
          onClose={() => setOverride(null)}
          onDone={() => {
            setOverride(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function Registration({
  detail,
  me,
  teams,
  teamName,
  onError,
  onNote,
  onChanged,
}: {
  detail: TournamentDetail;
  me: Me;
  teams: TeamInfo[];
  teamName: (id: string | null) => string | null;
  onError: (message: string | null) => void;
  onNote: (message: string | null) => void;
  onChanged: () => void;
}) {
  const { tournament, entries, yourOrganizer } = detail;
  const entered = new Set(entries.map((e) => e.teamId));
  const yourEligible = teams.filter(
    (t) => t.captainUserId === me.id && !entered.has(t.id),
  );
  const [picked, setPicked] = useState('');

  return (
    <section className="card">
      <div className="card-head">
        <h2>Registration</h2>
        <span className="pill plain">
          {entries.length}/{tournament.maxTeams} teams
        </span>
      </div>

      {yourEligible.length > 0 ? (
        <div className="actions">
          <select className="rolepick" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Enter your team…</option>
            {yourEligible.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.members.length} member{t.members.length === 1 ? '' : 's'})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-primary"
            disabled={!picked}
            onClick={async () => {
              onError(null);
              try {
                const result = await api.registerTeam(tournament.id, picked);
                onNote(result.warning ?? 'Entered.');
                setPicked('');
                onChanged();
              } catch (err) {
                onError(explain(err, 'Could not enter the team.'));
              }
            }}
          >
            Enter
          </button>
        </div>
      ) : (
        <p className="notes">
          Teams are entered by their captain. Create or fill yours on the Tournaments page first.
        </p>
      )}

      {entries.length > 0 ? (
        <ul className="feed">
          {entries.map((entry, index) => (
            <li key={entry.teamId}>
              <span>
                <strong>
                  {entry.seed ?? index + 1}. {teamName(entry.teamId)}
                </strong>{' '}
                — {entry.team?.members.length ?? '?'} member(s)
                {entry.team?.members.some((m) => !m.steamId) ? ' · missing Steam IDs' : ''}
              </span>
              <span className="rowtools">
                {yourOrganizer ? (
                  <>
                    {/* Seeding by nudging: random is fair, the organizer corrects. */}
                    <button
                      type="button"
                      className="btn-ghost small"
                      disabled={index === 0}
                      onClick={async () => {
                        const order = entries.map((e) => e.teamId);
                        const tmp = order[index - 1]!;
                        order[index - 1] = order[index]!;
                        order[index] = tmp;
                        await api.setSeeds(tournament.id, order).catch(() => undefined);
                        onChanged();
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn-ghost small"
                      disabled={index === entries.length - 1}
                      onClick={async () => {
                        const order = entries.map((e) => e.teamId);
                        const tmp = order[index + 1]!;
                        order[index + 1] = order[index]!;
                        order[index] = tmp;
                        await api.setSeeds(tournament.id, order).catch(() => undefined);
                        onChanged();
                      }}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
                {yourOrganizer || teams.find((t) => t.id === entry.teamId)?.captainUserId === me.id ? (
                  <button
                    type="button"
                    className="btn-ghost danger small"
                    onClick={async () => {
                      await api.withdrawTeam(tournament.id, entry.teamId).catch(() => undefined);
                      onChanged();
                    }}
                  >
                    Withdraw
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No teams yet.</p>
      )}
    </section>
  );
}

/** Wins first, then map difference, then rounds — only settled matches count. */
function Standings({
  matches,
  teamName,
}: {
  matches: TournamentMatch[];
  teamName: (id: string | null) => string | null;
}) {
  const rows = new Map<
    string,
    { wins: number; losses: number; mapsWon: number; mapsLost: number; roundDiff: number }
  >();
  const row = (teamId: string) => {
    if (!rows.has(teamId)) rows.set(teamId, { wins: 0, losses: 0, mapsWon: 0, mapsLost: 0, roundDiff: 0 });
    return rows.get(teamId)!;
  };
  for (const match of matches) {
    if ((match.status !== 'decided' && match.status !== 'forfeit') || !match.teamA || !match.teamB || !match.winner)
      continue;
    const a = row(match.teamA);
    const b = row(match.teamB);
    (match.winner === match.teamA ? a : b).wins++;
    (match.winner === match.teamA ? b : a).losses++;
    for (const map of match.maps) {
      if (map.scoreA > map.scoreB) (a.mapsWon++, b.mapsLost++);
      else if (map.scoreB > map.scoreA) (b.mapsWon++, a.mapsLost++);
      a.roundDiff += map.scoreA - map.scoreB;
      b.roundDiff += map.scoreB - map.scoreA;
    }
  }
  const sorted = [...rows.entries()].sort(
    ([, x], [, y]) =>
      y.wins - x.wins || y.mapsWon - y.mapsLost - (x.mapsWon - x.mapsLost) || y.roundDiff - x.roundDiff,
  );
  if (sorted.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Standings</h2>
      </div>
      <table className="standings">
        <thead>
          <tr>
            <th></th>
            <th>Team</th>
            <th>W</th>
            <th>L</th>
            <th>Maps</th>
            <th>Rounds ±</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(([teamId, s], index) => (
            <tr key={teamId}>
              <td className="pos">{index + 1}</td>
              <td>{teamName(teamId)}</td>
              <td>{s.wins}</td>
              <td>{s.losses}</td>
              <td>
                {s.mapsWon}–{s.mapsLost}
              </td>
              <td>
                {s.roundDiff > 0 ? '+' : ''}
                {s.roundDiff}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Bracket({
  matches,
  teamName,
  me,
  teams,
  yourOrganizer,
  finished,
  onSchedule,
  onOverride,
}: {
  matches: TournamentMatch[];
  teamName: (id: string | null) => string | null;
  me: Me;
  teams: TeamInfo[];
  yourOrganizer: boolean;
  tournamentId: string;
  finished: boolean;
  onSchedule: (round: number, at: number | null) => void;
  onOverride: (match: TournamentMatch) => void;
}) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1]!;
  const roundLabel = (round: number) =>
    round === lastRound ? 'Final' : round === lastRound - 1 ? 'Semi-finals' : `Round ${round}`;
  const yourTeamIds = new Set(
    teams.filter((t) => t.members.some((m) => m.userId === me.id)).map((t) => t.id),
  );
  const champion =
    finished ? matches.find((m) => m.round === lastRound && m.winner)?.winner ?? null : null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bracket</h2>
        {champion ? <span className="pill ok">🏆 {teamName(champion)}</span> : null}
      </div>
      <div className="bracket">
        {rounds.map((round) => (
          <div key={round} className="bracket-round">
            <h4 className="subhead">{roundLabel(round)}</h4>
            {yourOrganizer && !finished ? (
              <input
                type="datetime-local"
                className="roundtime"
                onChange={(e) => {
                  const at = e.target.value ? new Date(e.target.value).getTime() : null;
                  onSchedule(round, at);
                }}
              />
            ) : null}
            {matches
              .filter((m) => m.round === round)
              .map((match) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  teamName={teamName}
                  yours={
                    (match.teamA !== null && yourTeamIds.has(match.teamA)) ||
                    (match.teamB !== null && yourTeamIds.has(match.teamB))
                  }
                  canOverride={yourOrganizer && match.teamA !== null && match.teamB !== null}
                  onOverride={() => onOverride(match)}
                />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function MatchCard({
  match,
  teamName,
  yours,
  canOverride,
  onOverride,
}: {
  match: TournamentMatch;
  teamName: (id: string | null) => string | null;
  yours: boolean;
  canOverride: boolean;
  onOverride: () => void;
}) {
  const [connect, setConnect] = useState<string | null>(null);
  const joinable = yours && (match.status === 'ready' || match.status === 'live');
  const score = (side: 'scoreA' | 'scoreB') =>
    match.maps.length > 0 ? match.maps.map((m) => m[side]).join(' · ') : '';

  const row = (teamId: string | null, side: 'scoreA' | 'scoreB') => {
    const name = teamName(teamId) ?? '—';
    const winner = match.winner !== null && match.winner === teamId;
    return (
      <div className={`bracket-team${winner ? ' winner' : ''}`}>
        <span>{name}</span>
        <span className="score">{score(side)}</span>
      </div>
    );
  };

  return (
    <div className={`bracket-match${yours ? ' yours' : ''}`}>
      {row(match.teamA, 'scoreA')}
      {row(match.teamB, 'scoreB')}
      <div className="bracket-meta">
        <span>
          {MATCH_STATUS[match.status]}
          {match.status === 'forfeit' ? ` (${teamName(match.forfeitTeam)} no-show)` : ''}
          {match.scheduledAt && (match.status === 'pending' || match.status === 'provisioning')
            ? ` · ${new Date(match.scheduledAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
            : ''}
          {match.overrideBy ? ' · by organizer' : ''}
        </span>
        <span className="rowtools">
          {joinable ? (
            <button
              type="button"
              className="btn-ghost small"
              onClick={async () => {
                try {
                  const info = await api.matchConnect(match.id);
                  setConnect(info.connect);
                } catch {
                  setConnect('Not available yet.');
                }
              }}
            >
              How to join
            </button>
          ) : null}
          {canOverride && match.status !== 'provisioning' ? (
            <button type="button" className="btn-ghost small" onClick={onOverride}>
              Decide…
            </button>
          ) : null}
        </span>
      </div>
      {connect ? (
        <p className="hint">
          Paste in the CS2 console: <code>{connect}</code>
        </p>
      ) : null}
    </div>
  );
}

function OverrideDialog({
  match,
  teamName,
  onClose,
  onDone,
}: {
  match: TournamentMatch;
  teamName: (id: string | null) => string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [winner, setWinner] = useState(match.teamA ?? '');
  const [forfeit, setForfeit] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="Decide this match" onClose={onClose}>
      <p className="notes">
        The organizer's word outranks the game. This is also how a no-show becomes a forfeit. The
        reason lands in the activity log, visible to everyone.
      </p>
      <label className="field">
        <span>Winner</span>
        <select className="rolepick" value={winner} onChange={(e) => setWinner(e.target.value)}>
          {[match.teamA, match.teamB]
            .filter((t): t is string => t !== null)
            .map((teamId) => (
              <option key={teamId} value={teamId}>
                {teamName(teamId)}
              </option>
            ))}
        </select>
      </label>
      <label className="eventrow">
        <input type="checkbox" checked={forfeit} onChange={(e) => setForfeit(e.target.checked)} />
        <span>Forfeit — the other team did not show or gave up</span>
      </label>
      <label className="field">
        <span>Reason</span>
        <input
          value={reason}
          placeholder="e.g. team Bravo no-show after 15 minutes"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error ? <p className="hint bad">{error}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!winner || !reason.trim()}
          onClick={async () => {
            try {
              await api.overrideMatch(match.id, { winner, forfeit, reason: reason.trim() });
              onDone();
            } catch (err) {
              setError(explain(err, 'Could not record it.'));
            }
          }}
        >
          Record the result
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
