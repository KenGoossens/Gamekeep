import { useCallback, useEffect, useState } from 'react';
import { api, type CheckState, type HealthCheck, type HealthReport } from '../api.ts';

/**
 * Everything this portal depends on, in one place.
 *
 * It deliberately shows where each credential lives rather than letting you
 * edit it here: the tunnel token and any Cloudflare token stay outside the
 * portal, because a portal that holds them turns one password into control of
 * the whole domain -- including the gate that protects the portal itself.
 *
 * A healthy portal should be quiet, so a row is one line until you open it.
 * Anything not plainly fine opens itself, because that is the row you came for.
 */

/** State is never carried by colour alone; every row is labelled in words. */
const WORD: Record<CheckState, string> = {
  ok: 'ok',
  warn: 'attention',
  bad: 'problem',
  off: 'not in use',
  unknown: 'unknown',
};

function ago(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function Row({ check }: { check: HealthCheck }) {
  const quiet = check.state === 'ok';
  return (
    <details className={`check check-${check.state}`} open={!quiet}>
      <summary>
        <span className="check-dot" aria-hidden="true" />
        <span className="check-label">{check.label}</span>
        <span className="check-line">{check.summary}</span>
        <span className="check-state">{WORD[check.state]}</span>
      </summary>

      <div className="check-body">
        {check.detail ? <p className="check-detail">{check.detail}</p> : null}

        {check.facts.length > 0 ? (
          <dl className="check-facts">
            {check.facts.map((f) => (
              <div key={f.k}>
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {check.secretHome ? (
          <p className="check-secret">
            <span className="key-mark" aria-hidden="true">
              ⚿
            </span>
            {check.secretHome}
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.health(refresh));
    } catch {
      setError('Could not read the status.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  if (!report) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Status</h2>
        </div>
        <p className="empty">{error ?? 'Checking…'}</p>
      </section>
    );
  }

  const tally = report.checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});
  // Only the states actually present, so a healthy portal reads "8 ok".
  const summary = (['bad', 'warn', 'ok', 'off', 'unknown'] as CheckState[])
    .filter((s) => tally[s])
    .map((s) => `${tally[s]} ${WORD[s]}`)
    .join(' · ');

  const worst: CheckState = tally.bad ? 'bad' : tally.warn ? 'warn' : 'ok';

  return (
    <section className="card">
      <div className="card-head">
        <h2>Status</h2>
        <span className={`pill ${worst === 'ok' ? 'ok' : worst}`}>
          <span className="dot" />
          {summary}
        </span>
        <button
          type="button"
          className="btn-ghost small"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      <p className="notes">
        Checked {ago(report.checkedAt)} from inside the container. Credentials are never shown
        here — only whether they work, and where they are kept.
      </p>

      {error ? <p className="hint bad">{error}</p> : null}

      <div className="check-list">
        {report.checks.map((c) => (
          <Row key={c.id} check={c} />
        ))}
      </div>
    </section>
  );
}
