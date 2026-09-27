import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type AccessPolicy, type AccessStatus } from '../api.ts';

/**
 * Who may reach this portal at all.
 *
 * Cloudflare Access sits in front of Gamekeep's own login, so a policy there
 * is the guest list: an address on it lets someone reach the sign-in page,
 * and nothing more. That is why adding one is an operator's job while
 * connecting Cloudflare -- which stores a credential -- stays the owner's.
 */
export function AccessPanel() {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Connection form, only reachable by the owner.
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [policies, setPolicies] = useState<AccessPolicy[] | null>(null);
  const [policyId, setPolicyId] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.access();
      setStatus(next);
      if (next.accountId) setAccountId(next.accountId);
      if (next.policy) setPolicyId(next.policy.id);
    } catch {
      setError('Could not read the Access settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;

  function explain(err: unknown, fallback: string): string {
    return err instanceof ApiError && typeof err.body.message === 'string' ? err.body.message : fallback;
  }

  async function act(what: string, run: () => Promise<AccessPolicy>) {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const policy = await run();
      setStatus((prev) => (prev ? { ...prev, policy } : prev));
    } catch (err) {
      setError(explain(err, 'Cloudflare refused that change.'));
    } finally {
      setBusy(null);
    }
  }

  const policy = status.policy;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Who can reach the portal</h2>
        {status.configured && policy ? (
          <span className="pill ok">
            <span className="dot" />
            {policy.name}
          </span>
        ) : (
          <span className="pill">not connected</span>
        )}
      </div>

      <p className="notes">
        Cloudflare Access is the gate in front of this portal’s own login. An address here lets
        someone reach the sign-in page — they still need an account before they can do anything.
      </p>

      {status.configured && policy ? (
        <>
          <div className="seedrow">
            <input
              className="modsearch"
              type="email"
              value={email}
              placeholder="friend@example.com"
              autoComplete="off"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && email.trim()) {
                  void act('add', () => api.addAccessEmail(email)).then(() => setEmail(''));
                }
              }}
            />
            <button
              type="button"
              className="btn-primary small"
              disabled={!email.trim() || busy !== null}
              onClick={() =>
                void act('add', () => api.addAccessEmail(email)).then(() => setEmail(''))
              }
            >
              {busy === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>

          {note ? <p className="hint ok">{note}</p> : null}
          {error ? <p className="hint bad">{error}</p> : null}

          {policy.emails.length === 0 ? (
            <p className="empty">No individual addresses on this policy.</p>
          ) : (
            <ul className="modlist">
              {policy.emails.map((address) => (
                <li key={address}>
                  <span className="mod-name">{address}</span>
                  <button
                    type="button"
                    className="btn-ghost small danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!confirm(`Remove ${address}? They will no longer reach the portal.`)) return;
                      void act('remove', () => api.removeAccessEmail(address));
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Said plainly, because this panel only manages one kind of rule and
              an operator should not assume it shows the whole picture. */}
          {policy.otherIncludes > 0 || policy.requireRules > 0 || policy.excludeRules > 0 ? (
            <p className="hint">
              This policy also has {policy.otherIncludes} other allow rule
              {policy.otherIncludes === 1 ? '' : 's'}, {policy.requireRules} requirement
              {policy.requireRules === 1 ? '' : 's'} and {policy.excludeRules} exclusion
              {policy.excludeRules === 1 ? '' : 's'}. Gamekeep never touches those — change them in
              Cloudflare.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ---- connecting, owner only ---- */}
      {status.canConfigure ? (
        <details className="connect" open={!status.configured}>
          <summary>{status.configured ? 'Change the connection' : 'Connect Cloudflare'}</summary>

          <p className="hint">
            Create the token in Cloudflare under My Profile → API Tokens, with{' '}
            <strong>Account → Access: Apps and Policies → Edit</strong> and nothing else. A broader
            token would let this portal edit DNS and remove the gate protecting itself.
          </p>

          <label className="field">
            <span>Account ID</span>
            <input
              type="text"
              value={accountId}
              autoComplete="off"
              placeholder="From the Cloudflare dashboard sidebar"
              onChange={(e) => setAccountId(e.target.value)}
            />
          </label>

          <label className="field">
            <span>API token{status.configured ? ' — leave empty to keep the current one' : ''}</span>
            <input
              type="password"
              value={token}
              autoComplete="off"
              placeholder={status.configured ? '••••••••' : 'Scoped to Access: Apps and Policies'}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn-ghost"
              disabled={!accountId.trim() || busy !== null}
              onClick={async () => {
                setBusy('list');
                setError(null);
                try {
                  setPolicies((await api.accessPolicies(token, accountId)).policies);
                } catch (err) {
                  setError(explain(err, 'Could not list the policies.'));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'list' ? 'Looking…' : 'List policies'}
            </button>
          </div>

          {policies ? (
            <label className="field">
              <span>Policy this portal may edit</span>
              <select
                className="rolepick"
                value={policyId}
                onChange={(e) => setPolicyId(e.target.value)}
              >
                <option value="">Choose…</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.emails.length} address(es), {p.appCount} application(s)
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="actions">
            <button
              type="button"
              className="btn-primary"
              disabled={!policyId || !accountId.trim() || busy !== null}
              onClick={async () => {
                setBusy('connect');
                setError(null);
                try {
                  const r = await api.connectAccess(token, accountId, policyId);
                  setNote(`Connected — ${r.detail}`);
                  setToken('');
                  await load();
                } catch (err) {
                  setError(explain(err, 'Could not connect.'));
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'connect' ? 'Testing…' : status.configured ? 'Reconnect' : 'Connect'}
            </button>

            {status.configured ? (
              <button
                type="button"
                className="btn-ghost danger"
                disabled={busy !== null}
                onClick={async () => {
                  if (!confirm('Disconnect Cloudflare Access? The policy itself is left alone.')) return;
                  await api.disconnectAccess();
                  setPolicies(null);
                  await load();
                }}
              >
                Disconnect
              </button>
            ) : null}
          </div>

          {error ? <p className="hint bad">{error}</p> : null}
        </details>
      ) : null}
    </section>
  );
}
