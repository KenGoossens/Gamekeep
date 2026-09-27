import { useState } from 'react';
import { ApiError, api, type GameServer } from '../api.ts';

/**
 * Stop and start, for administrators only. Restarting is safe and
 * self-healing, so anyone may do it; deliberately leaving a server switched
 * off is not something a guest should be able to do.
 */
export function AdminControls({ server, onAction }: { server: GameServer; onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const job = server.activeJob;
  const working = Boolean(job && job.phase !== 'done' && job.phase !== 'failed');
  const unavailable = server.status.state === 'missing' || Boolean(server.status.error);

  async function run(action: 'start' | 'stop') {
    setBusy(true);
    setError(null);
    try {
      await (action === 'start' ? api.start(server.id) : api.stop(server.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setError('There is already an action running.');
      else if (err instanceof ApiError && err.status === 403) setError('Administrators only.');
      else setError(`Could not ${action} the server.`);
    } finally {
      setBusy(false);
      onAction();
    }
  }

  return (
    <div className="actions admin-actions">
      <span className="stat-label">Admin</span>
      <button
        type="button"
        className="btn-ghost small"
        disabled={busy || working || unavailable || server.status.running}
        onClick={() => void run('start')}
      >
        Start
      </button>
      <button
        type="button"
        className="btn-ghost small danger"
        disabled={busy || working || unavailable || !server.status.running}
        onClick={() => {
          const online = server.players?.online ?? 0;
          const warning =
            online > 0
              ? `${online} player${online === 1 ? ' is' : 's are'} online. Stop ${server.displayName} anyway?`
              : `Stop ${server.displayName}? It stays off until someone starts it again.`;
          if (confirm(warning)) void run('stop');
        }}
      >
        Stop
      </button>
      {error ? <span className="hint bad">{error}</span> : null}
    </div>
  );
}
