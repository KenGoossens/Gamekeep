import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, formatRelative, type Me, type PortalUser, type Role } from '../api.ts';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including managing these accounts.',
  operator: 'Install, stop, start and restart servers. No account management.',
  member: 'Restart servers only.',
};

const REFUSALS: Record<string, string> = {
  'last-owner': 'That would leave the portal with no owner.',
  'cannot-delete-self': 'You cannot delete your own account.',
  'cannot-disable-self': 'You cannot disable your own account.',
  'username-taken': 'That username is already in use.',
};

export function UsersPanel({ me }: { me: Me }) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  /** A generated password, shown once, for the admin to pass on. */
  const [handout, setHandout] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.users()).users);
    } catch {
      setError('Could not load the user list.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      await load();
      return result;
    } catch (err) {
      const code = err instanceof ApiError ? String(err.body.error) : '';
      setError(REFUSALS[code] ?? (err instanceof ApiError && typeof err.body.message === 'string'
        ? err.body.message
        : 'That did not work.'));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const result = await act(() => api.createUser(newName.trim(), newRole));
    if (result) {
      setHandout({ username: result.user.username, password: result.tempPassword });
      setNewName('');
      setNewRole('member');
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Users</h2>
        <span className="pill">{users.length}</span>
      </div>

      {handout ? (
        <div className="handout">
          <p>
            Temporary password for <strong>{handout.username}</strong>. It is shown once — copy it
            now. They must set their own password at first sign-in.
          </p>
          <code className="secret">{handout.password}</code>
          <div className="row">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void navigator.clipboard?.writeText(handout.password)}
            >
              Copy
            </button>
            <button type="button" className="btn-ghost" onClick={() => setHandout(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      <ul className="userlist">
        {users.map((u) => (
          <li key={u.id}>
            <span className="uname">
              {u.username}
              {u.id === me.id ? <span className="hint"> (you)</span> : null}
            </span>
            {u.role !== 'member' ? (
              <span className={u.role === 'owner' ? 'pill ok' : 'pill'} title={ROLE_HELP[u.role]}>
                {u.role}
              </span>
            ) : null}
            {u.disabled ? <span className="pill bad">disabled</span> : null}
            {u.mustChangePassword ? <span className="pill warn">temp password</span> : null}
            <span className="when">
              {u.lastLoginAt ? `seen ${formatRelative(u.lastLoginAt)}` : 'never signed in'}
            </span>

            <span className="urow-actions">
              <select
                className="rolepick"
                value={u.role}
                disabled={busy}
                title={ROLE_HELP[u.role]}
                onChange={(e) => void act(() => api.setRole(u.id, e.target.value as Role))}
              >
                <option value="member">member</option>
                <option value="operator">operator</option>
                <option value="owner">owner</option>
              </select>
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy}
                onClick={() => void act(() => api.setDisabled(u.id, !u.disabled))}
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy}
                onClick={async () => {
                  const r = await act(() => api.resetPassword(u.id));
                  if (r) setHandout({ username: u.username, password: r.tempPassword });
                }}
              >
                Reset password
              </button>
              <button
                type="button"
                className="btn-ghost small danger"
                disabled={busy || u.id === me.id}
                onClick={() => {
                  if (confirm(`Delete ${u.username}? This cannot be undone.`)) {
                    void act(() => api.deleteUser(u.id));
                  }
                }}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>

      {error ? <p className="hint bad">{error}</p> : null}

      <div className="addrow">
        <input
          placeholder="new username"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) void create();
          }}
        />
        <select
          className="rolepick"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as Role)}
          title={ROLE_HELP[newRole]}
        >
          <option value="member">member — restart only</option>
          <option value="operator">operator — manage servers</option>
        </select>
        <button type="button" className="btn-primary" disabled={busy || !newName.trim()} onClick={() => void create()}>
          Add user
        </button>
      </div>
    </section>
  );
}
