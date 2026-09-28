import { useEffect, useState } from 'react';
import { ApiError, api, type Role } from '../api.ts';

/**
 * Per-server exceptions to one user's global role.
 *
 * The mental model this screen protects: the global role is the rule, and a
 * row here is an exception for one server. So every server defaults to
 * "follows their role", exceptions are the visible odd ones out, and setting
 * an exception equal to the role simply clears it (the server does the same).
 * 'Hidden' is the strong one — the server disappears from their lists
 * entirely, and its pages answer as if it never existed.
 */

type Override = 'operator' | 'member' | 'none' | null;

interface AccessRow {
  id: string;
  displayName: string;
  override: Override;
}

export function UserAccessEditor({ userId, username }: { userId: string; username: string }) {
  const [role, setRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.userAccess(userId).then(
      (r) => {
        if (cancelled) return;
        setRole(r.role);
        setRows(r.servers);
      },
      () => !cancelled && setError('Could not read this user’s access.'),
    );
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function set(serverId: string, value: string) {
    setBusy(serverId);
    setError(null);
    const access = value === 'default' ? null : (value as Override);
    try {
      const result = await api.setUserAccess(userId, serverId, access);
      setRows((prev) =>
        (prev ?? []).map((r) =>
          r.id === serverId ? { ...r, override: result.override as Override } : r,
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not change that.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (error && !rows) return <p className="hint bad">{error}</p>;
  if (!rows || !role) return <p className="empty">Loading…</p>;

  return (
    <div className="accessgrid">
      <p className="hint">
        {username} is <strong>{role}</strong> everywhere, except where a row below says otherwise.
        “Hidden” removes the server from their portal entirely.
      </p>
      {error ? <p className="hint bad">{error}</p> : null}
      {rows.map((row) => (
        <label className="accessrow" key={row.id}>
          <span className={row.override ? 'accessname excepted' : 'accessname'}>
            {row.displayName}
          </span>
          <select
            value={row.override ?? 'default'}
            disabled={busy !== null}
            onChange={(e) => void set(row.id, e.target.value)}
          >
            <option value="default">follows their role ({role})</option>
            {role !== 'operator' ? <option value="operator">operator here</option> : null}
            {role !== 'member' ? <option value="member">member here</option> : null}
            <option value="none">hidden</option>
          </select>
        </label>
      ))}
    </div>
  );
}
