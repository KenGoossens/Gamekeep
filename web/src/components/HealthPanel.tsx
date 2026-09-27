import { useCallback, useEffect, useState } from 'react';
import { api, type CheckState, type HealthCheck, type HealthReport } from '../api.ts';

/**
 * Everything this portal depends on, in one place.
 *
 * It deliberately shows where each credential lives rather than letting you
 * edit it here: the tunnel token and any Cloudflare token stay outside the
 * portal, because a portal that holds them turns one password into control of
 * the whole domain -- including the gate that protects the portal itself.
 */

/** State is never carried by colour alone; every row is labelled in words. */
const WORD: Record<CheckState, string> = {
  ok: 'ok',
  warn: 'attention',
  bad: 'problem',
  off: 'not in use',
  unknown: 'unknown',
};

/** 'off' and 'unknown' are not failures, so they stay neutral grey. */
const TONE: Record<CheckState, string> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  off: 'plain',
  unknown: 'plain',
};

function ago(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function Row({ check }: { check: HealthCheck }) {
  return (
    <li className={`check check-${check.state}`}>
      <div className="check-head">
        <span className="check-label">{check.label}</span>
        <span className={`pill ${TONE[check.state]}`}>
          <span className="dot" />
          {WORD[check.state]}
        </span>
      </div>

      <p className="check-summary">{check.summary}</p>
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
    </li>
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
        <span className={`pill ${TONE[worst]}`}>
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
        Everything this portal depends on, checked {ago(report.checkedAt)} from inside the
        container. Credentials are never shown here — only whether they work, and where they are
        kept.
      </p>

      {error ? <p className="hint bad">{error}</p> : null}

      <ul className="check-list">
        {report.checks.map((c) => (
          <Row key={c.id} check={c} />
        ))}
      </ul>
    </section>
  );
}
