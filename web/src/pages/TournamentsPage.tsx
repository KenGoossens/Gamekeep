import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  canOperate,
  type Me,
  type TournamentSummary,
} from '../api.ts';
import { artworkUrl, fallbackHue } from '../api.ts';
import { linkProps } from '../router.ts';

const explain = (err: unknown, fallback: string): string =>
  err instanceof ApiError && typeof err.body.message === 'string' ? err.body.message : fallback;

const STATUS_LABEL: Record<TournamentSummary['status'], string> = {
  draft: 'draft',
  registration: 'registration open',
  running: 'running',
  finished: 'finished',
};

/**
 * Tournaments (beta). Everyone sees the list; teams live on each
 * tournament's own Teams tab.
 * and manages their own team; owners and operators also create tournaments.
 */
export function TournamentsPage({ me }: { me: Me }) {
  const [tournaments, setTournaments] = useState<TournamentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const t = await api.tournaments();
      setTournaments(t.tournaments);
    } catch {
      setError('Could not load the tournaments.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!tournaments) return <p className="empty">{error ?? 'Loading…'}</p>;

  return (
    <>
      <div className="page-head command-head">
        <div>
          <h1>
            Tournaments <sup className="beta-tag">beta</sup>
          </h1>
          <p>
            Brackets played on servers this portal builds per match and retires after. Beta: being
            tested and validated — expect rough edges, report what you hit.
          </p>
        </div>
        {canOperate(me.role) ? (
          <button type="button" className="btn-primary" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : 'New tournament'}
          </button>
        ) : null}
      </div>

      {error ? <p className="hint bad">{error}</p> : null}
      {creating ? <CreateTournament onDone={() => (setCreating(false), void load())} /> : null}

      {tournaments.length === 0 ? (
        <p className="empty">
          No tournaments yet.{' '}
          {canOperate(me.role)
            ? 'Create one, open registration, and let the captains enter.'
            : 'An operator can create one.'}
        </p>
      ) : (
        <div className="grid">
          {tournaments.map((t) => (
            <TournamentTile key={t.id} tournament={t} />
          ))}
        </div>
      )}

    </>
  );
}

/**
 * The same card a game server gets — poster art, status in the corner, name
 * at the foot. A tournament has no server id, but its game has a poster like
 * any other, served under the fixed game- namespace.
 */
function TournamentTile({ tournament: t }: { tournament: TournamentSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      {...linkProps(`/tournaments/${encodeURIComponent(t.id)}`)}
      className={`tile${t.status === 'running' ? '' : ' stopped'}`}
      style={{ '--hue': fallbackHue(t.id) } as React.CSSProperties}
    >
      {!failed ? (
        <img
          className="poster"
          src={artworkUrl(`game-${t.game}`, 'poster')}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="fallback" aria-hidden="true">
          {t.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="tile-top">
        <span className={`pill ${t.status === 'running' ? 'ok' : 'plain'}`}>
          <span className="dot" />
          {STATUS_LABEL[t.status]}
        </span>
      </div>
      <div className="tile-body">
        <span className="tile-name">{t.name}</span>
        <span className="tile-meta">
          <span>
            {t.gameLabel} · {t.teamSize}v{t.teamSize} · BO{t.bestOf}
          </span>
          <span>
            {t.entryCount}/{t.maxTeams} teams
          </span>
        </span>
      </div>
    </a>
  );
}

function CreateTournament({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [game, setGame] = useState('cs2');
  const [customGame, setCustomGame] = useState('');
  const [games, setGames] = useState<Array<{ key: string; label: string; auto: boolean }>>([]);
  const [teamSize, setTeamSize] = useState('5');
  const [maxTeams, setMaxTeams] = useState('8');
  const [bestOf, setBestOf] = useState('1');
  const [maps, setMaps] = useState('de_mirage, de_inferno, de_nuke, de_anubis');
  const [publicRosters, setPublicRosters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.tournamentGames().then((r) => setGames(r.games), () => undefined);
  }, []);
  const auto = game === 'cs2';

  return (
    <section className="card">
      <div className="card-head">
        <h2>New tournament</h2>
      </div>
      <p className="notes">
        Single elimination, any game. <strong>Counter-Strike 2</strong> builds a server per match
        and scores itself; for every other game the matches are played wherever you play — a
        standing server, another machine, a couch — and the organizer records each result.
      </p>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday Night Cup" />
      </label>
      <label className="field">
        <span>Game</span>
        <select className="rolepick" value={game} onChange={(e) => setGame(e.target.value)}>
          {games.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
              {g.auto ? ' — automatic results' : ''}
            </option>
          ))}
        </select>
      </label>
      {game === 'custom' ? (
        <label className="field">
          <span>Which game? (anything goes — a building contest counts)</span>
          <input
            value={customGame}
            placeholder="e.g. Mario Kart, Valheim build-off"
            onChange={(e) => setCustomGame(e.target.value)}
          />
        </label>
      ) : null}
      <div className="fieldrow">
        <label className="field">
          <span>Players per team</span>
          <input inputMode="numeric" value={teamSize} onChange={(e) => setTeamSize(e.target.value)} />
        </label>
        <label className="field">
          <span>Max teams</span>
          <input inputMode="numeric" value={maxTeams} onChange={(e) => setMaxTeams(e.target.value)} />
        </label>
        <label className="field">
          <span>Series</span>
          <select className="rolepick" value={bestOf} onChange={(e) => setBestOf(e.target.value)}>
            <option value="1">Best of 1</option>
            <option value="3">Best of 3</option>
            <option value="5">Best of 5</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>{auto ? 'Map pool (comma separated)' : 'Maps or arenas (optional, a note for the players)'}</span>
        <input
          value={maps}
          placeholder={auto ? 'de_mirage, de_inferno' : 'e.g. bedwars arena 2'}
          onChange={(e) => setMaps(e.target.value)}
        />
      </label>
      {auto ? (
        <p className="hint">
          A pool larger than the series length means the teams veto in-game; a pool of the same
          size plays in order.
        </p>
      ) : null}
      <label className="eventrow">
        <input
          type="checkbox"
          checked={publicRosters}
          onChange={(e) => setPublicRosters(e.target.checked)}
        />
        <span>Show player names on the public tournament page (team names always show)</span>
      </label>
      {error ? <p className="hint bad">{error}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || name.trim().length < 3 || (game === 'custom' && customGame.trim().length < 2)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.createTournament({
                name: name.trim(),
                game: game === 'custom' ? customGame.trim() : game,
                teamSize: Number(teamSize),
                maxTeams: Number(maxTeams),
                bestOf: Number(bestOf),
                mapPool: maps.split(',').map((m) => m.trim()).filter(Boolean),
                publicRosters,
              });
              onDone();
            } catch (err) {
              setError(explain(err, 'Could not create it.'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </section>
  );
}
