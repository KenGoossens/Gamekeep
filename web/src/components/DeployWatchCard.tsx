import { useEffect, useState } from 'react';
import { api, type DeployWatch } from '../api.ts';
import { navigate } from '../router.ts';

/**
 * The live tail of a deploy: the first boot followed until the game proves
 * itself, with the three honest endings spelled out. "Created" and "works"
 * are different claims, and this card is where the second one is earned.
 *
 * On failure the server is KEPT by default — a 35 GB download is not thrown
 * away over a late answer — with cleanup one deliberate click away.
 */
export function DeployWatchCard({
  watchId,
  serverId,
  serverName,
}: {
  watchId: string | null;
  serverId: string;
  serverName: string;
}) {
  const [watch, setWatch] = useState<DeployWatch | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!watchId) return;
    let live = true;
    const timer = setInterval(() => void poll(), 5000);
    function poll() {
      api.deployWatch(watchId!).then(
        (r) => {
          if (!live) return;
          setWatch(r.watch);
          // A settled verdict is final: stop asking, and keep showing it —
          // the server forgets the watch after a while, and a page left open
          // must not watch its own result vanish.
          if (r.watch.phase === 'settled') clearInterval(timer);
        },
        () => {
          // The watch retires half an hour after settling; a 404 before we
          // ever saw a result is history, afterwards the last result stands.
          if (!live) return;
          clearInterval(timer);
          setGone(true);
        },
      );
    }
    void poll();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [watchId]);

  // Gone without ever having seen a verdict: history, nothing to show.
  if (!watchId || (gone && !watch)) return null;

  const running = !watch || watch.phase !== 'settled';

  return (
    <section className="card">
      <div className="card-head">
        <h2>First boot</h2>
        {watch?.outcome === 'success' ? <span className="pill ok">verified</span> : null}
        {watch?.outcome === 'unconfirmed' ? <span className="pill warn">unconfirmed</span> : null}
        {watch?.outcome === 'failed' ? <span className="pill bad">failed</span> : null}
      </div>

      {running ? (
        <p className="notes">
          <span className="spinner" /> {watch?.message ?? 'Watching the first boot…'}
        </p>
      ) : (
        <p className={watch.outcome === 'success' ? 'hint ok' : watch.outcome === 'failed' ? 'hint bad' : 'hint'}>
          {watch.note}
        </p>
      )}

      {!running && watch.outcome === 'success' ? (
        <p className="notes">
          Want a different server name, world or password? The Settings tab on the server's page
          now has <strong>the game's own config file</strong> — change it there and the portal
          verifies the change the same way it just verified this boot.
        </p>
      ) : null}

      {!running && watch.outcome !== 'success' ? (
        <div className="actions">
          <button type="button" className="btn-primary" onClick={() => navigate(`/servers/${serverId}`)}>
            Open {serverName} — read the logs
          </button>
          <button
            type="button"
            className="btn-ghost danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete ${serverName} and everything it downloaded? This cannot be undone.`)) return;
              setBusy(true);
              setError(null);
              try {
                await api.deleteServer(serverId);
                navigate('/');
              } catch {
                setError('Could not delete it — try from the server card.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Clean up — delete the server
          </button>
        </div>
      ) : null}
      {error ? <p className="hint bad">{error}</p> : null}
    </section>
  );
}
