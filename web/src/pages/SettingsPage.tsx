import { useEffect, useState } from 'react';
import { ApiError, api, type RouterStatus } from '../api.ts';

/**
 * Owner-only. The router connection is optional: without it the portal still
 * says which ports a server needs, it just cannot open them for you.
 */
export function SettingsPage() {
  const [status, setStatus] = useState<RouterStatus | null>(null);
  const [provider, setProvider] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    api.router().then(
      (s) => {
        setStatus(s);
        setProvider(s.provider ?? s.providers[0]?.id ?? '');
        setValues(s.config ?? {});
      },
      () => setError('Could not read the router settings.'),
    );
  }, []);

  if (!status) return <p className="empty">{error ?? 'Loading…'}</p>;

  const definition = status.providers.find((p) => p.id === provider);
  const missingRequired = (definition?.fields ?? []).some(
    (f) => !f.optional && !(values[f.key] ?? '').trim(),
  );

  async function connect() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.connectRouter(provider, values);
      setOk(`Connected — ${r.detail}`);
      setStatus(await api.router());
      // Secrets are not echoed back, so clear them from the form too.
      setValues((prev) => {
        const next = { ...prev };
        for (const f of definition?.fields ?? []) if (f.secret) delete next[f.key];
        return next;
      });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not connect to the router.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Connections this portal uses. Only the owner can change these.</p>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Router</h2>
          {status.configured ? (
            <span className="pill ok">
              <span className="dot" />
              connected
            </span>
          ) : (
            <span className="pill">not connected</span>
          )}
        </div>

        <p className="notes">
          Optional. Connect a router and opening the ports a new game server needs takes one click.
          Without it the portal still lists the rules to make by hand.
        </p>

        {!status.lanAddress ? (
          <p className="hint bad">
            LAN_ADDRESS is not set, so forwards have no destination. Set it in .env to this machine's
            address on your network.
          </p>
        ) : (
          <p className="hint">
            Forwards will point at <code>{status.lanAddress}</code>.
          </p>
        )}

        <label className="field">
          <span>Router type</span>
          <select
            className="rolepick"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setValues({});
            }}
          >
            {status.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {(definition?.fields ?? []).map((f) => (
          <label className="field" key={f.key}>
            <span>
              {f.label}
              {f.optional ? ' (optional)' : ''}
              {f.secret && status.configured ? ' — leave empty to keep the current one' : ''}
            </span>
            <input
              type={f.secret ? 'password' : 'text'}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder}
              autoComplete="off"
              onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </label>
        ))}

        {ok ? <p className="hint ok">{ok}</p> : null}
        {error ? <p className="hint bad">{error}</p> : null}

        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || missingRequired}
            onClick={() => void connect()}
          >
            {busy ? 'Testing…' : status.configured ? 'Reconnect' : 'Connect'}
          </button>
          {status.configured ? (
            <button
              type="button"
              className="btn-ghost danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm('Disconnect the router? Port forwarding becomes manual again.')) return;
                await api.disconnectRouter();
                setStatus(await api.router());
                setOk(null);
              }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
