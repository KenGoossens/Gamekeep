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
import { TeamsPanel } from '../components/TeamsPanel.tsx';
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
  const [people, setPeople] = useState<Array<{ id: string; username: string }>>([]);
  const [tab, setTab] = useState<'tournament' | 'teams'>('tournament');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [override, setOverride] = useState<TournamentMatch | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t, p] = await Promise.all([api.tournament(id), api.teams(), api.teamPeople()]);
      setDetail(d);
      setTeams(t.teams);
      setPeople(p.people);
    } catch {
      setError('Could not load this tournament.');
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Live enough for match night without a socket: the bracket is small.
    // A hidden tab asks for nothing; it catches up when it is looked at.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
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
            {tournament.gameLabel} ·{' '}
            {tournament.format === 'double'
              ? 'double elimination'
              : tournament.format === 'roundrobin'
                ? 'round robin'
                : 'single elimination'}{' '}
            · {tournament.teamSize}v{tournament.teamSize} · BO
            {tournament.bestOf}
            {tournament.mapPool.length > 0 ? ` · ${tournament.mapPool.join(', ')}` : ''} ·{' '}
            {tournament.status}
            {!tournament.autoResults ? ' · results by the organizer' : ''}
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
              className="btn-ghost"
              onClick={() => {
                // Next week's tournament is this week's with a new date:
                // settings and entered teams come along, results do not.
                void act(async () => {
                  const { tournament: copy } = await api.cloneTournament(tournament.id);
                  navigate(`/tournaments/${copy.id}`);
                }, 'Could not clone it.');
              }}
            >
              Clone
            </button>
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

      {/* The same tab strip the server page wears: the bracket is the show,
          team administration its own room. */}
      <nav className="tabs">
        {(
          [
            ['tournament', 'Tournament'],
            ['teams', 'Teams'],
          ] as Array<['tournament' | 'teams', string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'teams' ? (
        <TeamsPanel me={me} teams={teams} people={people} onChanged={() => void load()} />
      ) : null}

      {tab === 'tournament' && tournament.status === 'draft' ? (
        <p className="empty">
          A draft: only organizers see it does anything. Open registration to let captains enter.
        </p>
      ) : null}

      {tab === 'tournament' && tournament.status === 'registration' ? (
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

      {tab === 'tournament' && matches.length > 0 ? <Standings matches={matches} teamName={teamName} /> : null}

      {tab === 'tournament' && matches.length > 0 ? (
        <Bracket
          matches={matches}
          teamName={teamName}
          me={me}
          teams={teams}
          yourOrganizer={yourOrganizer}
          tournamentId={tournament.id}
          format={tournament.format}
          auto={tournament.autoResults}
          finished={tournament.status === 'finished'}
          onSchedule={(bracket, round, at) =>
            void act(
              () => api.scheduleTournamentRound(tournament.id, bracket, round, at),
              'Could not schedule the round.',
            )
          }
          onOverride={setOverride}
          onChanged={() => void load()}
          onError={setError}
          onNote={setNote}
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
          Teams are entered by their captain. Create or fill yours on the Teams tab above.
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
  format,
  auto,
  finished,
  onSchedule,
  onOverride,
  onChanged,
  onError,
  onNote,
}: {
  matches: TournamentMatch[];
  teamName: (id: string | null) => string | null;
  me: Me;
  teams: TeamInfo[];
  yourOrganizer: boolean;
  tournamentId: string;
  format: string;
  auto: boolean;
  finished: boolean;
  onSchedule: (bracket: 'wb' | 'lb' | 'gf', round: number, at: number | null) => void;
  onOverride: (match: TournamentMatch) => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onNote: (message: string | null) => void;
}) {
  // One column per (bracket, round); the API already serves them in play
  // order: winners, then losers, then the grand final.
  const columns: Array<{ bracket: TournamentMatch['bracket']; round: number }> = [];
  for (const m of matches) {
    if (!columns.some((c) => c.bracket === m.bracket && c.round === m.round)) {
      columns.push({ bracket: m.bracket, round: m.round });
    }
  }
  const lastOf = (bracket: TournamentMatch['bracket']) =>
    Math.max(0, ...matches.filter((m) => m.bracket === bracket).map((m) => m.round));
  const roundLabel = (bracket: TournamentMatch['bracket'], round: number): string => {
    if (bracket === 'gf') return 'Grand final';
    if (format === 'roundrobin') return `Round ${round}`;
    if (format === 'double') {
      const side = bracket === 'wb' ? 'Winners' : 'Losers';
      return round === lastOf(bracket) ? `${side} final` : `${side} round ${round}`;
    }
    const last = lastOf('wb');
    return round === last ? 'Final' : round === last - 1 ? 'Semi-finals' : `Round ${round}`;
  };
  const yourTeamIds = new Set(
    teams.filter((t) => t.members.some((m) => m.userId === me.id)).map((t) => t.id),
  );
  /** Teams this user captains — check-in and reporting are captain's work. */
  const captainIds = new Set(teams.filter((t) => t.captainUserId === me.id).map((t) => t.id));
  const champion = finished
    ? format === 'double'
      ? (matches.find((m) => m.bracket === 'gf')?.winner ?? null)
      : format === 'roundrobin'
        ? null // round robin crowns via the standings table above
        : (matches.find((m) => m.bracket === 'wb' && m.round === lastOf('wb'))?.winner ?? null)
    : null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>{format === 'roundrobin' ? 'Rounds' : 'Bracket'}</h2>
        {champion ? <span className="pill ok">🏆 {teamName(champion)}</span> : null}
      </div>
      <div className="bracket">
        {columns.map((column) => (
          <div key={`${column.bracket}-${column.round}`} className="bracket-round">
            <h4 className="subhead">{roundLabel(column.bracket, column.round)}</h4>
            {yourOrganizer && !finished ? (
              <input
                type="datetime-local"
                className="roundtime"
                onChange={(e) => {
                  const at = e.target.value ? new Date(e.target.value).getTime() : null;
                  onSchedule(column.bracket, column.round, at);
                }}
              />
            ) : null}
            {matches
              .filter((m) => m.bracket === column.bracket && m.round === column.round)
              .map((match) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  teamName={teamName}
                  auto={auto}
                  captainIds={captainIds}
                  yours={
                    (match.teamA !== null && yourTeamIds.has(match.teamA)) ||
                    (match.teamB !== null && yourTeamIds.has(match.teamB))
                  }
                  canOverride={yourOrganizer && match.teamA !== null && match.teamB !== null}
                  onOverride={() => onOverride(match)}
                  onChanged={onChanged}
                  onError={onError}
                  onNote={onNote}
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
  auto,
  captainIds,
  yours,
  canOverride,
  onOverride,
  onChanged,
  onError,
  onNote,
}: {
  match: TournamentMatch;
  teamName: (id: string | null) => string | null;
  auto: boolean;
  captainIds: Set<string>;
  yours: boolean;
  canOverride: boolean;
  onOverride: () => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
  onNote: (message: string | null) => void;
}) {
  const [connect, setConnect] = useState<string | null>(null);
  const joinable = yours && (match.status === 'ready' || match.status === 'live');
  const open = match.status !== 'decided' && match.status !== 'forfeit';
  const score = (side: 'scoreA' | 'scoreB') =>
    match.maps.length > 0 ? match.maps.map((m) => m[side]).join(' · ') : '';

  /** The side this user captains in this match, if any. */
  const yourSide: 'A' | 'B' | null =
    match.teamA !== null && captainIds.has(match.teamA)
      ? 'A'
      : match.teamB !== null && captainIds.has(match.teamB)
        ? 'B'
        : null;
  const yourTeamId = yourSide === 'A' ? match.teamA : yourSide === 'B' ? match.teamB : null;
  const yourCheckin = yourSide === 'A' ? match.checkinA : match.checkinB;
  const yourReport = yourSide === 'A' ? match.reportA : match.reportB;
  const conflict =
    match.reportA !== null && match.reportB !== null && match.reportA !== match.reportB;

  const row = (teamId: string | null, side: 'scoreA' | 'scoreB') => {
    const name = teamName(teamId) ?? '—';
    const winner = match.winner !== null && match.winner === teamId;
    const checkedIn = side === 'scoreA' ? match.checkinA !== null : match.checkinB !== null;
    return (
      <div className={`bracket-team${winner ? ' winner' : ''}`}>
        <span>
          {name}
          {open && teamId !== null && checkedIn ? (
            <span className="checked" title="Checked in">
              {' '}
              ✓
            </span>
          ) : null}
        </span>
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
          {conflict && open ? ' · reports disagree' : ''}
        </span>
        <span className="rowtools">
          {yourSide && yourTeamId && open && match.teamA && match.teamB ? (
            <button
              type="button"
              className="btn-ghost small"
              onClick={async () => {
                onError(null);
                try {
                  await api.matchCheckin(match.id, yourTeamId, yourCheckin === null);
                  onChanged();
                } catch (err) {
                  onError(explain(err, 'Could not check in.'));
                }
              }}
            >
              {yourCheckin === null ? 'Check in' : 'Undo check-in'}
            </button>
          ) : null}
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
      {!auto && yourSide && open && match.teamA && match.teamB ? (
        <div className="bracket-meta">
          <span>{yourReport ? `You reported: ${teamName(yourReport)}` : 'Report the result:'}</span>
          <span className="rowtools">
            {[match.teamA, match.teamB].map((teamId) => (
              <button
                key={teamId}
                type="button"
                className={`btn-ghost small${yourReport === teamId ? ' active' : ''}`}
                onClick={async () => {
                  onError(null);
                  try {
                    const result = await api.matchReport(match.id, teamId);
                    onNote(
                      result.agreed
                        ? 'Both captains agree — the result stands.'
                        : result.conflict
                          ? 'The other captain reported differently; the organizer decides.'
                          : 'Reported. The result stands once the other captain agrees.',
                    );
                    onChanged();
                  } catch (err) {
                    onError(explain(err, 'Could not report the result.'));
                  }
                }}
              >
                {teamName(teamId)} won
              </button>
            ))}
          </span>
        </div>
      ) : null}
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
