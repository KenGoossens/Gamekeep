import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type CatalogApp, type ValidationAppResult, type ValidationRun } from '../api.ts';

/**
 * Validation Runs, for the owner: prove that what the portal offers still
 * turns into a working server from nothing, on this very machine. The targets
 * are catalogue apps — anything the Add server tab can deploy — picked
 * through the same search. Each is deployed for real, held to the same
 * first-boot verification a user's deploy gets, and torn down completely,
 * downloads included (ADR-0003): a run that passes on a warm cache has proven
 * nothing about the path a new user walks.
 */

const OUTCOME_LABEL: Record<string, { text: string; cls: string }> = {
  success: { text: 'verified', cls: 'pill ok' },
  unconfirmed: { text: 'unconfirmed', cls: 'pill warn' },
  failed: { text: 'failed', cls: 'pill bad' },
  refused: { text: 'template refused', cls: 'pill bad' },
  skipped: { text: 'skipped', cls: 'pill plain' },
  error: { text: 'error', cls: 'pill bad' },
};

const STATUS_LABEL: Record<ValidationAppResult['status'], string> = {
  pending: 'waiting its turn',
  resolving: 'finding its template',
  deploying: 'deploying',
  verifying: 'first boot — verifying',
  'tearing-down': 'tearing down',
  done: '',
};

export function ValidationPage() {
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [current, setCurrent] = useState<ValidationRun | null>(null);
  const [history, setHistory] = useState<ValidationRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api.validationState();
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

  // The same catalogue the Add server tab searches; debounced lightly.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.catalog(query).then(
        (r) => {
          if (!live) return;
          setApps(r.apps);
          setTotal(r.total);
        },
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const running = current !== null && current.finishedAt === null;

  const toggle = (app: CatalogApp) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(app.id)) next.delete(app.id);
      else next.set(app.id, app.name);
      return next;
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Validation</h1>
          <p>
            Deploy any catalogue app for real, verify its first boot the way a user's deploy is
            verified, then tear everything down — container, volume, downloads. One app at a time.
          </p>
        </div>
      </div>

      {error ? <p className="hint bad">{error}</p> : null}

      <section className="card">
        <div className="card-head">
          <h2>Pick apps</h2>
          <span className="pill plain">{picked.size} selected</span>
        </div>
        <p className="notes">
          The honest price: every run downloads each app from scratch — a recognised game proves
          itself by answering <em>as the name it was given</em>; anything else is verified as far
          as it honestly can be, its port accepting connections. Apps your live servers share
          ports with are skipped with the reason.
        </p>
        <label className="field">
          <span>Search the catalogue ({total} apps)</span>
          <input
            value={query}
            placeholder="valheim, minecraft, satisfactory…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ul className="feed" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {apps.map((app) => (
            <li key={app.id}>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={picked.has(app.id)}
                  disabled={running}
                  onChange={() => toggle(app)}
                />
                <strong>{app.name}</strong>
                <span className="mod-meta"> {app.publisher}</span>
              </label>
            </li>
          ))}
          {apps.length === 0 ? <li className="empty">Nothing matches that search.</li> : null}
        </ul>
        {picked.size > 0 ? (
          <p className="notes">
            Selected:{' '}
            {[...picked.entries()].map(([id, name]) => (
              <button
                key={id}
                type="button"
                className="btn-ghost small"
                disabled={running}
                title="Remove from the selection"
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Map(prev);
                    next.delete(id);
                    return next;
                  })
                }
              >
                {name} ✕
              </button>
            ))}
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={running || busy || picked.size === 0}
            onClick={async () => {
              if (!confirm(`Validate ${picked.size} app(s)? Each downloads from scratch and is deleted afterwards.`)) return;
              setBusy(true);
              setError(null);
              try {
                await api.startValidation([...picked.keys()]);
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
            {running ? 'A run is going…' : `Validate ${picked.size || ''} app${picked.size === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={running || apps.length === 0}
            onClick={() =>
              setPicked((prev) => {
                const next = new Map(prev);
                for (const app of apps) next.set(app.id, app.name);
                return next;
              })
            }
          >
            Add all shown
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
              Cancel — finish the current app's teardown, skip the rest
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
        {run.apps.map((a) => (
          <li key={a.app}>
            <span>
              <strong>{a.label}</strong>
              {a.status !== 'done' ? (
                <> — <span className="spinner" /> {STATUS_LABEL[a.status]}</>
              ) : null}
              {a.note ? <span className="fieldhelp" style={{ display: 'block' }}>{a.note}</span> : null}
            </span>
            {a.outcome ? (
              <span className={OUTCOME_LABEL[a.outcome]?.cls ?? 'pill plain'}>
                {OUTCOME_LABEL[a.outcome]?.text ?? a.outcome}
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
  for (const a of run.apps) {
    const k = a.outcome ?? 'error';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <details className="handout" style={{ marginBottom: 8 }}>
      <summary>
        {new Date(run.startedAt).toLocaleString()} — {run.apps.length} app(s):{' '}
        {[...counts.entries()].map(([k, n]) => `${n} ${OUTCOME_LABEL[k]?.text ?? k}`).join(', ')}
        {run.cancelled ? ' (cancelled)' : ''}
      </summary>
      <ul className="feed">
        {run.apps.map((a) => (
          <li key={a.app}>
            <span>
              <strong>{a.label}</strong>
              {a.note ? <span className="fieldhelp" style={{ display: 'block' }}>{a.note}</span> : null}
            </span>
            {a.outcome ? (
              <span className={OUTCOME_LABEL[a.outcome]?.cls ?? 'pill plain'}>
                {OUTCOME_LABEL[a.outcome]?.text ?? a.outcome}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
