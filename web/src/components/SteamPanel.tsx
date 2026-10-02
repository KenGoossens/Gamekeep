import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type SteamGsltStatus } from '../api.ts';

/**
 * The Steam Web API key behind automatic game server tokens.
 *
 * Every CS2 match server has to present a login token to Steam, and without
 * this key someone has to go mint those by hand on a Steam web page before
 * every tournament night. With it, the portal mints one per match and cleans
 * it up afterwards — the owner pastes a key once and never thinks about
 * tokens again.
 */
export function SteamPanel() {
  const [status, setStatus] = useState<SteamGsltStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.steamTokens());
    } catch {
      setError('Could not read the Steam settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;

  const pill = !status.configured
    ? { className: 'pill', label: 'not connected' }
    : status.ok
      ? { className: 'pill ok', label: 'connected' }
      : { className: 'pill warn', label: 'key not working' };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Steam game server tokens</h2>
        <span className={pill.className}>
          <span className="dot" />
          {pill.label}
        </span>
      </div>

      <p className="notes">
        Tournament match servers each need a Steam game server login token. With a Steam Web API
        key, the portal creates one per match and removes it afterwards — nothing to mint by hand.
        Get a key at steamcommunity.com/dev/apikey; the account must not be limited.
      </p>

      {status.configured && status.ok ? (
        <p className="hint">
          {status.tokenCount === 1
            ? 'The Steam account holds 1 game server token.'
            : `The Steam account holds ${status.tokenCount ?? 0} game server tokens.`}
        </p>
      ) : null}
      {status.banned ? (
        <p className="hint bad">
          Steam reports this account is banned from hosting game servers. Tokens from it will not
          work.
        </p>
      ) : null}
      {status.configured && status.ok === false ? (
        <p className="hint bad">{status.error ?? 'The stored key no longer works.'}</p>
      ) : null}

      <label className="field">
        <span>
          Steam Web API key{status.configured ? ' — leave empty to keep the current one' : ''}
        </span>
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          placeholder={status.configured ? '••••••••' : '32 hex characters'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>

      {note ? <p className="hint ok">{note}</p> : null}
      {error ? <p className="hint bad">{error}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !apiKey.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setNote(null);
            try {
              const next = await api.saveSteamKey(apiKey.trim());
              setStatus(next);
              setApiKey('');
              setNote('Saved — the key was checked against Steam.');
            } catch (err) {
              setError(
                err instanceof ApiError && typeof err.body.message === 'string'
                  ? err.body.message
                  : 'Could not save.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking…' : status.configured ? 'Replace key' : 'Connect and check'}
        </button>

        {status.configured ? (
          <button
            type="button"
            className="btn-ghost danger"
            disabled={busy}
            onClick={async () => {
              if (
                !confirm(
                  'Disconnect Steam? Match servers can no longer get tokens automatically. Tokens already on the Steam account stay there.',
                )
              )
                return;
              setStatus(await api.disableSteamTokens());
              setNote(null);
              setError(null);
            }}
          >
            Disconnect
          </button>
        ) : null}
      </div>
    </section>
  );
}
