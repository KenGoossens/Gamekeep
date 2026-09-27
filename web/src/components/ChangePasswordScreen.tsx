import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api.ts';

/**
 * Shown when an account still carries the temporary password an admin handed
 * out. Until this is done the API refuses everything else, so a temp password
 * on its own can never restart a server.
 */
export function ChangePasswordScreen({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.body.error === 'wrong-current-password') {
        setError('That temporary password is not correct.');
      } else if (err instanceof ApiError && err.body.error === 'password-unchanged') {
        setError('Pick a password different from the temporary one.');
      } else if (err instanceof ApiError && typeof err.body.message === 'string') {
        setError(err.body.message);
      } else {
        setError('Could not change the password. Try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card wide-card" onSubmit={submit}>
        <h1>Choose a password</h1>
        <p>
          You are signed in with a temporary password. Set your own to finish — nothing else works
          until you do.
        </p>

        <label className="field">
          <span>Temporary password</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>

        <label className="field">
          <span>New password (at least 10 characters)</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
        </label>

        <label className="field">
          <span>Confirm new password</span>
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
          disabled={busy || mismatch || !current || next.length < 10}
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
        <button type="button" className="btn-ghost wide" onClick={() => void api.logout().finally(onDone)}>
          Sign out instead
        </button>
      </form>
    </div>
  );
}
