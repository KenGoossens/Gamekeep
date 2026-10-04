import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type CatalogApp,
  type ValidationAppResult,
  type ValidationRun,
  type ValidationSchedule,
} from '../api.ts';

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

/** One pickable row, whichever tab it came from. */
interface PickRow {
  key: string;
  name: string;
  meta: string;
  target: { kind: 'catalog'; id: string } | { kind: 'steam'; appId: number };
}

export function ValidationPage() {
  const [source, setSource] = useState<'catalog' | 'steam'>('catalog');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PickRow[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<Map<string, PickRow>>(new Map());
  const [current, setCurrent] = useState<ValidationRun | null>(null);
  const [history, setHistory] = useState<ValidationRun[]>([]);
  const [schedule, setSchedule] = useState<ValidationSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api.validationState();
      setCurrent(state.current);
      setHistory(state.history);
      setSchedule(state.schedule);
    } catch {
      setError('Could not read the validation state.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  // The same two searches the Add server tab offers; debounced lightly.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      if (source === 'catalog') {
        api.catalog(query).then(
          (r) => {
            if (!live) return;
            setRows(
              r.apps.map((app: CatalogApp) => ({
                key: `c:${app.id}`,
                name: app.name,
                meta: app.publisher,
                target: { kind: 'catalog', id: app.id },
              })),
            );
            setTotal(r.total);
          },
          () => undefined,
        );
      } else {
        api.steamSearch(query).then(
          (r) => {
            if (!live) return;
            setRows(
              r.results.slice(0, 60).map((s) => ({
                key: `s:${s.appId}`,
                name: s.name,
                meta: s.known ? `Steam · ${s.known}` : `Steam app ${s.appId}`,
                target: { kind: 'steam', appId: s.appId },
              })),
            );
            setTotal(r.total);
          },
          () => undefined,
        );
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, source]);

  const running = current !== null && current.finishedAt === null;

  const toggle = (row: PickRow) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.set(row.key, row);
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
        <nav className="tabs" style={{ margin: '18px 0 14px' }}>
          {(
            [
              ['catalog', 'Unraid apps'],
              ['steam', 'Steam dedicated servers'],
            ] as Array<['catalog' | 'steam', string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={source === key ? 'tab active' : 'tab'}
              onClick={() => setSource(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="field">
          <span>
            Search {source === 'catalog' ? `the catalogue (${total} apps)` : `Steam's dedicated servers (${total})`}
          </span>
          <input
            value={query}
            placeholder="valheim, minecraft, satisfactory…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ul className="feed picklist">
          {rows.map((row) => (
            <li key={row.key}>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={picked.has(row.key)}
                  disabled={running}
                  onChange={() => toggle(row)}
                />
                <strong>{row.name}</strong>
                <span className="mod-meta">{row.meta}</span>
              </label>
            </li>
          ))}
          {rows.length === 0 ? <li className="empty">Nothing matches that search.</li> : null}
        </ul>
        {picked.size > 0 ? (
          <p className="notes">
            Selected:{' '}
            {[...picked.values()].map((row) => (
              <button
                key={row.key}
                type="button"
                className="btn-ghost small"
                disabled={running}
                title="Remove from the selection"
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Map(prev);
                    next.delete(row.key);
                    return next;
                  })
                }
              >
                {row.name} ✕
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
                const targets = [...picked.values()];
                await api.startValidation(
                  targets.filter((t) => t.target.kind === 'catalog').map((t) => (t.target as { id: string }).id),
                  targets
                    .filter((t) => t.target.kind === 'steam')
                    .map((t) => ({ appId: (t.target as { appId: number }).appId, name: t.name })),
                );
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
            disabled={running || rows.length === 0}
            onClick={() =>
              setPicked((prev) => {
                const next = new Map(prev);
                for (const row of rows) next.set(row.key, row);
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

      <ScheduleCard
        schedule={schedule}
        picked={picked}
        onError={setError}
        onChanged={() => void load()}
      />

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

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The standing instruction: run a saved selection at a set time on set days —
 * the night before a release is the classic. Saving captures the CURRENT
 * selection above; the schedule then runs that exact list, whatever is later
 * picked for manual runs.
 */
function ScheduleCard({
  schedule,
  picked,
  onError,
  onChanged,
}: {
  schedule: ValidationSchedule | null;
  picked: Map<string, PickRow>;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [time, setTime] = useState('04:00');
  const [days, setDays] = useState<Set<number>>(new Set([1]));
  const [busy, setBusy] = useState(false);

  const toggleDay = (d: number) =>
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });

  return (
    <section className="card">
      <div className="card-head">
        <h2>Schedule</h2>
        {schedule?.enabled ? (
          <span className="pill ok">
            {schedule.targets.length} app(s) at {schedule.time} on{' '}
            {schedule.days.map((d) => DAY_LABELS[d]).join(', ')}
          </span>
        ) : (
          <span className="pill plain">none</span>
        )}
      </div>
      <p className="notes">
        Runs the saved selection on the portal's own clock — the night before a release is the
        classic. A missed time stays missed (the portal must be up at that minute), and a
        scheduled run never stacks on one already going.
      </p>
      <div className="fieldrow">
        <label className="field">
          <span>Time (24h, portal clock)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Days</span>
          <span>
            {DAY_LABELS.map((label, d) => (
              <label key={label} className="checkline" style={{ marginRight: 10 }}>
                <input type="checkbox" checked={days.has(d)} onChange={() => toggleDay(d)} />
                {label}
              </label>
            ))}
          </span>
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || picked.size === 0 || days.size === 0}
          title={picked.size === 0 ? 'Pick apps above first — the schedule saves that selection' : undefined}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              const targets = [...picked.values()];
              await api.setValidationSchedule({
                enabled: true,
                time,
                days: [...days],
                apps: targets.filter((t) => t.target.kind === 'catalog').map((t) => (t.target as { id: string }).id),
                steam: targets
                  .filter((t) => t.target.kind === 'steam')
                  .map((t) => ({ appId: (t.target as { appId: number }).appId, name: t.name })),
              });
              onChanged();
            } catch (err) {
              onError(
                err instanceof ApiError && typeof err.body.message === 'string'
                  ? err.body.message
                  : 'Could not save the schedule.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Save schedule — {picked.size} selected app{picked.size === 1 ? '' : 's'}
        </button>
        {schedule ? (
          <button
            type="button"
            className="btn-ghost danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.setValidationSchedule(null);
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove the schedule
          </button>
        ) : null}
      </div>
    </section>
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
