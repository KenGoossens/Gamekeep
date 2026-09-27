import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';

/**
 * Shown only while no account exists. The setup token is printed to the
 * container log, so claiming the first admin account needs access to the
 * server, not just to this page.
 */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.setup(token.trim(), username, password);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('That setup token is not correct. Check the container log.');
      } else if (err instanceof ApiError && err.status === 409) {
        setError('An account already exists. Reload to sign in.');
      } else if (err instanceof ApiError && typeof err.body.message === 'string') {
        setError(err.body.message);
      } else {
        setError('Could not create the account. Try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card wide-card" onSubmit={submit}>
        <img className="brandmark" src="/logo.png" alt="" width={64} height={64} />
        <h1>Set up Gamekeep</h1>
        <p>
          No accounts exist yet. Create the administrator account — it can add everyone else
          afterwards.
        </p>
        <p className="hint">
          The setup token was printed to the container log when Gamekeep started. On Unraid:{' '}
          <code>docker logs gamekeep</code>
        </p>

        <label className="field">
          <span>Setup token</span>
          <input value={token} onChange={(e) => setToken(e.target.value)} autoFocus required />
        </label>

        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span>Password (at least 10 characters)</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>

        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        {mismatch ? <p className="hint bad">Passwords do not match.</p> : null}
        {error ? <p className="hint bad">{error}</p> : null}

        <button
          type="submit"
          className="btn-primary wide"
          disabled={busy || mismatch || !token || !username || password.length < 10}
        >
          {busy ? 'Creating…' : 'Create administrator'}
        </button>
      </form>
    </div>
  );
}
