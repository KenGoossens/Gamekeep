import { useEffect, useState } from 'react';
import { api, type ServerUpdateStatus } from '../api.ts';

/**
 * The Steam-build comparison for one server, honest "cannot tell" included.
 * Rendered only when there is something to say: an update, or the result of a
 * check the operator just asked for. For SteamCMD-installed servers a restart
 * IS the update — which is the one sentence this card exists to deliver.
 */
export function UpdateCard({ serverId, canOperate }: { serverId: string; canOperate: boolean }) {
  const [status, setStatus] = useState<ServerUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    api.serverUpdate(serverId).then(
      (r) => {
        if (live) setStatus(r.update);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [serverId]);

  // Quiet until there is news, or until the operator asks.
  if (!status?.updateAvailable && !asked && !canOperate) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Game updates</h2>
        {status?.updateAvailable ? <span className="pill warn">update available</span> : null}
        {status && !status.updateAvailable && status.latestBuild ? (
          <span className="pill ok">up to date</span>
        ) : null}
      </div>
      {status?.updateAvailable ? (
        <p className="notes">
          Steam ships build <code>{status.latestBuild}</code>; this server runs{' '}
          <code>{status.installedBuild}</code>. <strong>A restart installs it</strong> — these
          servers run SteamCMD on every start.
        </p>
      ) : status?.latestBuild ? (
        <p className="notes">
          Installed build <code>{status.installedBuild}</code> matches what Steam ships. Checked
          automatically every six hours.
        </p>
      ) : status?.note ? (
        <p className="notes">{status.note}</p>
      ) : (
        <p className="notes">Not checked yet — the first automatic round runs shortly after boot.</p>
      )}
      {canOperate ? (
        <div className="actions">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setAsked(true);
              try {
                const r = await api.serverUpdateCheck(serverId);
                setStatus(r.update);
              } catch {
                // The card keeps whatever it knew; the note explains enough.
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Checking…' : 'Check now'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
