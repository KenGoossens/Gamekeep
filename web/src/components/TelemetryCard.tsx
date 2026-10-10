import { useEffect, useState } from 'react';
import { api, type TelemetryState } from '../api.ts';

/**
 * The anonymous-statistics switch, built on one principle: nothing is asked
 * for that cannot be shown. The literal payload sits right under the toggle,
 * every line of it, because "trust us" is not a privacy policy. Off by
 * default, forever reversible.
 */
export function TelemetryCard() {
  const [state, setState] = useState<TelemetryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.telemetry().then(setState, () => setError('Could not read the statistics state.'));
  }, []);

  if (!state) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Anonymous usage statistics</h2>
        {state.enabled ? <span className="pill ok">on</span> : <span className="pill plain">off</span>}
      </div>
      <p className="notes">
        <strong>Off by default.</strong> Opted in, GameKeepr sends <strong>one ping per hour</strong>{' '}
        with exactly the payload below — the version, the platform, which <em>games</em> run (never
        your server names, addresses, players or logs) and which features see use. It feeds the
        public statistics page, so you can see the same numbers everyone else does. The random
        install id exists only so one install is not counted twice; it identifies nothing.
        {state.statsUrl ? (
          <>
            {' '}
            <a href={state.statsUrl} target="_blank" rel="noreferrer">
              See the public statistics page ↗
            </a>
          </>
        ) : null}
      </p>

      {!state.endpointConfigured ? (
        <p className="hint">
          This build has no statistics endpoint configured, so nothing is sent even when enabled —
          said here rather than pretended otherwise.
        </p>
      ) : null}

      <h3 className="subhead">Exactly what would be sent</h3>
      <pre className="handout" style={{ overflowX: 'auto', fontSize: '0.8rem' }}>
        {JSON.stringify(state.payload, null, 2)}
      </pre>

      {state.lastSentAt ? (
        <p className="notes">
          Last sent {new Date(state.lastSentAt).toLocaleString()}
          {state.lastStatus && state.lastStatus !== 'ok' ? ` — ${state.lastStatus}` : ''}.
        </p>
      ) : state.enabled && state.lastStatus ? (
        <p className="hint">{state.lastStatus}</p>
      ) : null}
      {error ? <p className="hint bad">{error}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={async () => {
            // The prefilled body is right there in GitHub's form before
            // anything is submitted — consent per report, nothing silent.
            try {
              const { url } = await api.issueTemplate();
              window.open(url, '_blank', 'noreferrer');
            } catch {
              window.open('https://github.com/KenGoossens/Gamekeep/issues/new', '_blank', 'noreferrer');
            }
          }}
        >
          Report an issue on GitHub
        </button>
        <button
          type="button"
          className={state.enabled ? 'btn-ghost' : 'btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setState(await api.setTelemetry(!state.enabled));
            } catch {
              setError('Could not change the setting.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : state.enabled ? 'Turn off' : 'Opt in — share the payload above, hourly'}
        </button>
      </div>
    </section>
  );
}
