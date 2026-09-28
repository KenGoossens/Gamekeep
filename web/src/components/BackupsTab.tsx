import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Backup, type BackupList } from '../api.ts';

/**
 * World backups. Two decisions carry this screen:
 *
 * - What goes in is chosen once and shown always. The paths sit at the top of
 *   the tab, because "what did my backups actually contain" must never be a
 *   surprise discovered during a restore.
 * - Restoring reads as the serious act it is. It needs the server stopped,
 *   it says that a safety copy is made first, and the pre-restore copies are
 *   labelled for what they are.
 */

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const KIND_LABEL: Record<Backup['kind'], string> = {
  manual: '',
  scheduled: 'scheduled',
  'pre-restore': 'safety copy made before a restore',
};

export function BackupsTab({ serverId }: { serverId: string }) {
  const [list, setList] = useState<BackupList | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.backups(serverId);
      setList(next);
      setChosen(next.paths.length > 0 ? next.paths : next.suggestions);
      setError(null);
    } catch {
      setError('Could not read the backups.');
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function explain(err: unknown, fallback: string): string {
    return err instanceof ApiError && typeof err.body.message === 'string'
      ? err.body.message
      : fallback;
  }

  async function savePaths(paths: string[]) {
    setBusy('paths');
    setError(null);
    try {
      await api.setBackupPaths(serverId, paths);
      setNote('Saved. Every backup from now on contains exactly these paths.');
      await load();
    } catch (err) {
      setError(explain(err, 'Could not save the paths.'));
    } finally {
      setBusy(null);
    }
  }

  async function make() {
    setBusy('make');
    setError(null);
    setNote(null);
    try {
      const { backup } = await api.makeBackup(serverId);
      setNote(`Backed up ${bytes(backup.sizeBytes)}.`);
      await load();
    } catch (err) {
      setError(explain(err, 'The backup failed.'));
    } finally {
      setBusy(null);
    }
  }

  async function restore(backup: Backup) {
    if (
      !confirm(
        `Restore the backup of ${when(backup.createdAt)}?\n\n` +
          'The current state is saved first as a safety copy, then the backup is put back. ' +
          'Files created since the backup are left alone.',
      )
    )
      return;
    setBusy(backup.id);
    setError(null);
    setNote(null);
    try {
      await api.restoreBackup(serverId, backup.id);
      setNote('Restored. The replaced state is in the safety copy, in case this was the wrong call.');
      await load();
    } catch (err) {
      setError(explain(err, 'The restore failed.'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(backup: Backup) {
    if (!confirm(`Delete the backup of ${when(backup.createdAt)}? This cannot be undone.`)) return;
    setBusy(backup.id);
    setError(null);
    try {
      await api.deleteBackup(serverId, backup.id);
      await load();
    } catch (err) {
      setError(explain(err, 'Could not delete it.'));
    } finally {
      setBusy(null);
    }
  }

  if (!list) return <p className="empty">{error ?? 'Loading…'}</p>;

  const configured = list.paths.length > 0;

  return (
    <>
      <p className="notes">
        A backup holds the world and its settings — the part no reinstall can bring back. The game
        itself is not in it; SteamCMD can always fetch that again.
      </p>
      {error ? <p className="hint bad">{error}</p> : null}
      {note ? <p className="hint ok">{note}</p> : null}

      {/* ---- what goes in ---- */}
      <h3 className="subhead">What gets backed up</h3>
      {configured ? (
        <>
          <ul className="modlist">
            {list.paths.map((p) => (
              <li key={p}>
                <span className="mod-name">
                  <code>{p}</code>
                </span>
                <button
                  type="button"
                  className="btn-ghost small danger"
                  disabled={busy !== null}
                  onClick={() => void savePaths(list.paths.filter((x) => x !== p))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : list.suggestions.length > 0 ? (
        <>
          <p className="hint">
            Found where this game keeps its saves. Confirm it, and backups can start.
          </p>
          <ul className="modlist">
            {chosen.map((p) => (
              <li key={p}>
                <span className="mod-name">
                  <code>{p}</code>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null || chosen.length === 0}
            onClick={() => void savePaths(chosen)}
          >
            {busy === 'paths' ? 'Saving…' : 'Use these paths'}
          </button>
        </>
      ) : (
        <p className="hint">
          {list.registryKnows
            ? 'Nothing found yet — a server that has never run has no saves. Start it once, then come back.'
            : 'Gamekeep does not know where this game keeps its saves. Add the directory below; the Files tab helps you find it.'}
        </p>
      )}

      <div className="addrow">
        <input
          type="text"
          value={extra}
          placeholder="Add a container path, e.g. /serverdata/serverfiles/Zomboid/Saves"
          onChange={(e) => setExtra(e.target.value)}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={busy !== null || !extra.trim().startsWith('/')}
          onClick={() => {
            void savePaths([...list.paths, extra.trim()]);
            setExtra('');
          }}
        >
          Add path
        </button>
      </div>

      {/* ---- the backups ---- */}
      <h3 className="subhead">Backups</h3>
      <div className="row" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || !configured}
          onClick={() => void make()}
        >
          {busy === 'make' ? 'Backing up…' : 'Back up now'}
        </button>
        {list.running ? (
          <span className="hint">
            The server is running: the game saves continually, so a backup now is fine — it simply
            captures the last save.
          </span>
        ) : null}
      </div>

      {list.backups.length === 0 ? (
        <p className="empty">No backups yet. The first one is the one you will wish you had.</p>
      ) : (
        <ul className="modlist">
          {list.backups.map((b) => (
            <li key={b.id}>
              <span className="mod-name">
                {when(b.createdAt)} <span className="mod-version">{bytes(b.sizeBytes)}</span>
              </span>
              <span className="mod-meta">
                by {b.createdBy}
                {KIND_LABEL[b.kind] ? ` · ${KIND_LABEL[b.kind]}` : ''}
              </span>
              <span className="urow-actions">
                <a
                  className="btn-ghost small"
                  href={`/api/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(b.id)}/download`}
                >
                  Download
                </a>
                <button
                  type="button"
                  className="btn-ghost small"
                  disabled={busy !== null || list.running}
                  title={list.running ? 'Stop the server first' : undefined}
                  onClick={() => void restore(b)}
                >
                  {busy === b.id ? '…' : 'Restore'}
                </button>
                <button
                  type="button"
                  className="btn-ghost small danger"
                  disabled={busy !== null}
                  onClick={() => void remove(b)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        The newest ten are kept; older ones are dropped automatically. Safety copies made before a
        restore do not count against that. For a nightly backup, add one on the Schedule tab.
      </p>
    </>
  );
}
