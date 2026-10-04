import { useEffect, useState } from 'react';
import { ApiError, api, type GameSettingsScan } from '../api.ts';
import { DeployWatchCard } from './DeployWatchCard.tsx';

const LABELS: Record<string, string> = {
  name: 'Server name',
  world: 'World',
  password: 'Password',
  admin: 'Admin password',
};

/**
 * The game's OWN configuration file, found inside the server and edited in
 * place: the join settings with labels, the rest of the file left to the
 * Files tab. Saving restarts the server and hands the result to a
 * verification watch — the name-match is the proof the game really read what
 * was written, which is also how an env-templating image gets caught.
 */
export function GameSettingsCard({ serverId, serverName }: { serverId: string; serverName: string }) {
  const [scan, setScan] = useState<GameSettingsScan | null>(null);
  const [supported, setSupported] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const r = await api.gameSettings(serverId);
      setSupported(r.supported);
      setScan(r.scan);
    } catch {
      // A scan that cannot run is a quiet absence here; the Files tab remains.
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  if (!loaded || !supported) return null;

  if (!scan) {
    return (
      <>
        <h3 className="subhead">The game's own config file</h3>
        <p className="notes">
          This game keeps its settings in its own file, but none exists yet — the game writes one
          on its first boot. Start the server once, then come back.
        </p>
      </>
    );
  }

  const dirty = Object.keys(edits).length > 0;

  return (
    <>
      <h3 className="subhead">The game's own config file</h3>
      <p className="notes">
        Read from <code>{scan.file}</code> inside the server — the file the game actually loads,
        whatever the image calls its variables. Everything else in it is editable on the Files tab.
      </p>
      {scan.envAuthoritative ? (
        <p className="hint">
          This game's common images <strong>rewrite this file from environment variables on every
          start</strong> — edit the matching variables above instead, or a change here is silently
          undone. Shown read-only for exactly that reason.
        </p>
      ) : null}

      {scan.values.map((row) => (
        <label className="field" key={row.key}>
          <span>
            {LABELS[row.key] ?? row.key} <code className="fieldkey">{row.fileKey}</code>
          </span>
          <input
            value={edits[row.key] ?? row.value ?? ''}
            readOnly={scan.envAuthoritative}
            autoComplete="off"
            onChange={(e) => setEdits((prev) => ({ ...prev, [row.key]: e.target.value }))}
          />
        </label>
      ))}

      {error ? <p className="hint bad">{error}</p> : null}

      {!scan.envAuthoritative ? (
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={!dirty || busy}
            onClick={async () => {
              if (!confirm('Apply and restart the server? The portal then verifies the game read it.')) return;
              setBusy(true);
              setError(null);
              setWatchId(null);
              try {
                const result = await api.applyGameSettings(serverId, edits);
                setEdits({});
                setWatchId(result.watchId);
                await load();
              } catch (err) {
                setError(
                  err instanceof ApiError && typeof err.body.message === 'string'
                    ? err.body.message
                    : 'Could not write the file.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Applying…' : 'Apply to the file'}
          </button>
          {dirty ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEdits({})}>
              Discard
            </button>
          ) : null}
        </div>
      ) : null}

      {watchId ? <DeployWatchCard watchId={watchId} serverId={serverId} serverName={serverName} /> : null}
    </>
  );
}
