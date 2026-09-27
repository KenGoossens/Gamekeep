import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type CheckState,
  type HealthCheck,
  type HealthReport,
  type ScannerSettings as ScannerSettingsType,
} from '../api.ts';

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

/**
 * Where the malware scanners are configured.
 *
 * Kept beside the status panel rather than on the mod screen: it is a property
 * of this portal, not of any one game server, and an operator installing a mod
 * should find it already decided.
 */
export function ScannerSettings() {
  const [current, setCurrent] = useState<ScannerSettingsType | null>(null);
  const [key, setKey] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('3310');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.scanners().then(
      (s) => {
        setCurrent(s);
        setHost(s.clamavHost);
        setPort(String(s.clamavPort));
      },
      () => setNote('Could not read the scanner settings.'),
    );
  }, []);

  if (!current) return null;

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      await api.saveScanners({
        virustotalApiKey: key.trim() || undefined,
        clamavHost: host.trim(),
        clamavPort: Number(port) || 3310,
      });
      setCurrent(await api.scanners());
      setKey('');
      setNote('Saved.');
    } catch {
      setNote('Could not save.');
    } finally {
      setBusy(false);
    }
  }

  const any = current.virustotal || Boolean(current.clamavHost);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Malware scanning</h2>
        <span className={`pill ${any ? 'ok' : 'warn'}`}>
          <span className="dot" />
          {any ? 'configured' : 'none'}
        </span>
      </div>

      <p className="notes">
        Used when a mod is downloaded, before anything is written. Neither of these can tell you a
        mod is safe — a mod is code that runs inside your game server. What they give is the
        multi-engine opinion on those exact bytes.
      </p>

      <label className="field">
        <span>
          VirusTotal API key{current.virustotal ? ' — set; leave empty to keep it' : ' (optional)'}
        </span>
        <input
          type="password"
          value={key}
          autoComplete="off"
          placeholder={current.virustotal ? '••••••••' : 'From your VirusTotal account'}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <p className="hint">
        Looked up by hash, so the file itself is never uploaded anywhere. A free account is enough.
      </p>

      <label className="field">
        <span>ClamAV host (optional)</span>
        <input
          type="text"
          value={host}
          autoComplete="off"
          placeholder="clamav"
          onChange={(e) => setHost(e.target.value)}
        />
      </label>
      <label className="field">
        <span>ClamAV port</span>
        <input type="text" value={port} onChange={(e) => setPort(e.target.value)} />
      </label>
      <p className="hint">
        A clamd instance reachable from this container. The file is streamed to it; nothing leaves
        your network.
      </p>

      {note ? <p className="hint ok">{note}</p> : null}

      <div className="actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
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
