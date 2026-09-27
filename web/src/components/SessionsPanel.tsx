import { useCallback, useEffect, useState } from 'react';
import { api, type ActiveSession } from '../api.ts';

/**
 * Who is signed in right now.
 *
 * Separate from the account list on purpose: an account is who *may* sign in,
 * a session is who *has*. The distinction is the whole point — an account you
 * forgot about is a risk, but a session from an address you do not recognise
 * is a live one.
 */

function ago(ts: number | null): string {
  if (ts === null) return 'unknown';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Turns a user-agent string into something worth showing in a table cell. */
function device(ua: string | null): string {
  if (!ua) return 'unknown';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'a browser';

  const platform =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '';

  return platform ? `${browser} on ${platform}` : browser;
}

export function SessionsPanel() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
      setError(null);
    } catch {
      setError('Could not read who is signed in.');
    }
  }, []);

  useEffect(() => {
    void load();
    // Slow on purpose: this answers "who is here", which does not change by
    // the second, and a faster poll would write nothing but noise.
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!sessions) return null;

  const people = new Set(sessions.map((s) => s.username)).size;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Signed in now</h2>
        <span className={`pill ${sessions.length > 0 ? 'ok' : 'plain'}`}>
          <span className="dot" />
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
          {people !== sessions.length ? ` · ${people} people` : ''}
        </span>
        <button type="button" className="btn-ghost small" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <p className="notes">
        A session is a browser that is signed in. Signing one out is immediate; the person can sign
        in again unless you also disable the account.
      </p>

      {error ? <p className="hint bad">{error}</p> : null}

      {sessions.length === 0 ? (
        <p className="empty">Nobody is signed in.</p>
      ) : (
        <ul className="modlist">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="mod-name">
                {s.username}
                <span className="mod-flag session-role">{s.role}</span>
                {s.current ? <span className="mod-flag session-you">this browser</span> : null}
                <span className="mod-meta">
                  {' '}
                  {device(s.userAgent)} · {s.ip ?? 'address not recorded'}
                </span>
              </span>
              <span className="mod-meta">
                seen {ago(s.lastSeenAt)} · in since {ago(s.createdAt)}
              </span>
              <button
                type="button"
                className="btn-ghost small danger"
                disabled={busy !== null}
                onClick={async () => {
                  const what = s.current
                    ? 'Sign yourself out of this browser?'
                    : `Sign ${s.username} out of that browser?`;
                  if (!confirm(what)) return;
                  setBusy(s.id);
                  try {
                    await api.signOutSession(s.id);
                    if (s.current) window.location.reload();
                    else await load();
                  } catch {
                    setError('Could not sign that session out.');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
