import { useState } from 'react';
import { ApiError, api, type Me, type TeamInfo } from '../api.ts';

const explain = (err: unknown, fallback: string): string =>
  err instanceof ApiError && typeof err.body.message === 'string' ? err.body.message : fallback;

/**
 * Team management: create a team, captain its roster, set Steam64 ids. Teams
 * outlive any one tournament — Rocket Goats enters every cup — which is why
 * this panel edits global teams even though it lives on a tournament's Teams
 * tab: that is where people look for it.
 */
export function TeamsPanel({
  me,
  teams,
  people,
  onChanged,
}: {
  me: Me;
  teams: TeamInfo[];
  people: Array<{ id: string; username: string }>;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [steamId, setSteamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.username ?? '…';

  const mine = teams.filter((t) => t.captainUserId === me.id);
  const others = teams.filter((t) => t.captainUserId !== me.id);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Teams</h2>
      </div>
      <p className="notes">
        A team is captained by whoever creates it, and outlives any one tournament. Steam IDs
        matter for CS2: the match server reserves player slots by Steam64 ID, so a member without
        one cannot claim their seat.
      </p>

      <div className="fieldrow">
        <label className="field">
          <span>New team</span>
          <input value={name} placeholder="Team name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Your Steam64 ID (optional, 17 digits)</span>
          <input value={steamId} onChange={(e) => setSteamId(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn-primary fieldrow-action"
          disabled={name.trim().length < 2}
          onClick={async () => {
            setError(null);
            try {
              await api.createTeam(name.trim(), steamId.trim() || undefined);
              setName('');
              onChanged();
            } catch (err) {
              setError(explain(err, 'Could not create the team.'));
            }
          }}
        >
          Create
        </button>
      </div>
      {error ? <p className="hint bad">{error}</p> : null}

      {mine.map((team) => (
        <TeamEditor key={team.id} team={team} people={people} onChanged={onChanged} />
      ))}

      {others.length > 0 ? (
        <>
          <h4 className="subhead">Other teams</h4>
          <ul className="feed">
            {others.map((t) => (
              <li key={t.id}>
                <span>
                  <strong>{t.name}</strong> — {t.members.map((m) => nameOf(m.userId)).join(', ')}
                  {t.members.some((m) => m.userId === me.id) ? ' (you play here)' : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function TeamEditor({
  team,
  people,
  onChanged,
}: {
  team: TeamInfo;
  people: Array<{ id: string; username: string }>;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.username ?? '…';
  const available = people.filter((p) => !team.members.some((m) => m.userId === p.id));

  return (
    <div className="teamcard">
      <div className="card-head">
        <h3>{team.name}</h3>
        <button
          type="button"
          className="btn-ghost danger small"
          onClick={async () => {
            if (!confirm(`Delete ${team.name}?`)) return;
            try {
              await api.deleteTeam(team.id);
              onChanged();
            } catch (err) {
              setError(explain(err, 'Could not delete it.'));
            }
          }}
        >
          Delete team
        </button>
      </div>
      <ul className="feed">
        {team.members.map((m) => (
          <li key={m.userId}>
            <span>
              <strong>{nameOf(m.userId)}</strong>
              {m.userId === team.captainUserId ? ' (captain)' : ''}
            </span>
            <span className="rowtools">
              <input
                className="steamid"
                defaultValue={m.steamId ?? ''}
                placeholder="Steam64 ID"
                onBlur={async (e) => {
                  const value = e.target.value.trim();
                  if (value === (m.steamId ?? '')) return;
                  try {
                    await api.setTeamMemberSteamId(team.id, m.userId, value);
                    onChanged();
                  } catch (err) {
                    setError(explain(err, 'Could not save the Steam ID.'));
                  }
                }}
              />
              {m.userId !== team.captainUserId ? (
                <button
                  type="button"
                  className="btn-ghost danger small"
                  onClick={async () => {
                    try {
                      await api.removeTeamMember(team.id, m.userId);
                      onChanged();
                    } catch (err) {
                      setError(explain(err, 'Could not remove them.'));
                    }
                  }}
                >
                  Remove
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {available.length > 0 ? (
        <div className="actions">
          <select className="rolepick" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a member…</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.username}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-ghost"
            disabled={!adding}
            onClick={async () => {
              try {
                await api.addTeamMember(team.id, adding);
                setAdding('');
                onChanged();
              } catch (err) {
                setError(explain(err, 'Could not add them.'));
              }
            }}
          >
            Add
          </button>
        </div>
      ) : null}
      {error ? <p className="hint bad">{error}</p> : null}
    </div>
  );
}
