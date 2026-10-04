import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type ValidationGameResult, type ValidationRun } from '../api.ts';

/**
 * Validation Runs, for the owner: prove that the registry's data still turns
 * into a working server from nothing, on this very machine. Each selected
 * game is deployed for real, held to the same first-boot verification a
 * user's deploy gets, and torn down completely — downloads included, which is
 * the deliberate price (ADR-0003): a run that passes on a warm cache has
 * proven nothing about the path a new user walks.
 */

const OUTCOME_LABEL: Record<string, { text: string; cls: string }> = {
  success: { text: 'verified', cls: 'pill ok' },
  unconfirmed: { text: 'unconfirmed', cls: 'pill warn' },
  failed: { text: 'failed', cls: 'pill bad' },
  refused: { text: 'template refused', cls: 'pill bad' },
  skipped: { text: 'skipped', cls: 'pill plain' },
  error: { text: 'error', cls: 'pill bad' },
};

const STATUS_LABEL: Record<ValidationGameResult['status'], string> = {
  pending: 'waiting its turn',
  resolving: 'finding its template',
  deploying: 'deploying',
  verifying: 'first boot — verifying',
  'tearing-down': 'tearing down',
  done: '',
};

export function ValidationPage() {
  const [games, setGames] = useState<Array<{ key: string; label: string }>>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<ValidationRun | null>(null);
  const [history, setHistory] = useState<ValidationRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api.validationState();
      setGames(state.games);
      setCurrent(state.current);
      setHistory(state.history);
    } catch {
      setError('Could not read the validation state.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const running = current !== null && current.finishedAt === null;

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Validation</h1>
          <p>
            Deploy each selected game for real, verify its first boot the way a user's deploy is
            verified, then tear everything down — container, volume, downloads. One game at a
            time.
          </p>
        </div>
      </div>

      {error ? <p className="hint bad">{error}</p> : null}

      <section className="card">
        <div className="card-head">
          <h2>Start a run</h2>
        </div>
        <p className="notes">
          The honest price: every run downloads each game from scratch — hundreds of gigabytes for
          a full sweep — because a warm cache would skip exactly the first-install experience being
          tested. After one full run, a subset is the normal working mode.
        </p>
        <div className="tagrow" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {games.map((g) => (
            <label key={g.key} className="checkline" style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={picked.has(g.key)}
                disabled={running}
                onChange={() => toggle(g.key)}
              />
              {g.label}
            </label>
          ))}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={running || busy || picked.size === 0}
            onClick={async () => {
              if (!confirm(`Validate ${picked.size} game(s)? Each downloads from scratch and is deleted afterwards.`)) return;
              setBusy(true);
              setError(null);
              try {
                await api.startValidation([...picked]);
                await load();
              } catch (err) {
                setError(
                  err instanceof ApiError && typeof err.body.message === 'string'
                    ? err.body.message
                    : 'Could not start the run.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {running ? 'A run is going…' : `Validate ${picked.size || ''} game${picked.size === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || picked.size === games.length}
            onClick={() => setPicked(new Set(games.map((g) => g.key)))}
          >
            Select all
          </button>
          {running ? (
            <button
              type="button"
              className="btn-ghost danger"
              onClick={async () => {
                await api.cancelValidation().catch(() => undefined);
                await load();
              }}
            >
              Cancel — finish the current game's teardown, skip the rest
            </button>
          ) : null}
        </div>
      </section>

      {current ? <RunCard run={current} title={running ? 'Running now' : 'Last run'} /> : null}

      {history.filter((run) => run.id !== current?.id).length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>History</h2>
          </div>
          {history
            .filter((run) => run.id !== current?.id)
            .map((run) => (
              <RunSummary key={run.id} run={run} />
            ))}
        </section>
      ) : null}
    </>
  );
}

function RunCard({ run, title }: { run: ValidationRun; title: string }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="pill plain">
          started {new Date(run.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} by {run.startedBy}
        </span>
      </div>
      <ul className="feed">
        {run.games.map((g) => (
          <li key={g.game}>
            <span>
              <strong>{g.label}</strong>
              {g.status !== 'done' ? (
                <> — <span className="spinner" /> {STATUS_LABEL[g.status]}</>
              ) : null}
              {g.note ? <span className="fieldhelp" style={{ display: 'block' }}>{g.note}</span> : null}
            </span>
            {g.outcome ? (
              <span className={OUTCOME_LABEL[g.outcome]?.cls ?? 'pill plain'}>
                {OUTCOME_LABEL[g.outcome]?.text ?? g.outcome}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunSummary({ run }: { run: ValidationRun }) {
  const counts = new Map<string, number>();
  for (const g of run.games) {
    const k = g.outcome ?? 'error';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <details className="handout" style={{ marginBottom: 8 }}>
      <summary>
        {new Date(run.startedAt).toLocaleString()} — {run.games.length} game(s):{' '}
        {[...counts.entries()].map(([k, n]) => `${n} ${OUTCOME_LABEL[k]?.text ?? k}`).join(', ')}
        {run.cancelled ? ' (cancelled)' : ''}
      </summary>
      <ul className="feed">
        {run.games.map((g) => (
          <li key={g.game}>
            <span>
              <strong>{g.label}</strong>
              {g.note ? <span className="fieldhelp" style={{ display: 'block' }}>{g.note}</span> : null}
            </span>
            {g.outcome ? (
              <span className={OUTCOME_LABEL[g.outcome]?.cls ?? 'pill plain'}>
                {OUTCOME_LABEL[g.outcome]?.text ?? g.outcome}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
