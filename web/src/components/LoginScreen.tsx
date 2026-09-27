import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      onSignedIn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const seconds = Number(err.body.retryAfterSeconds) || 0;
        setError(`Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`);
      } else {
        // The server does not distinguish wrong password from unknown account,
        // and neither does this message.
        setError('That username and password did not match.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Gamekeep</h1>
        <p>Sign in to check on the game servers and restart them when an update lands.</p>

        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error ? <p className="hint bad">{error}</p> : null}

        <button type="submit" className="btn-primary wide" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
