import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type FileEntry } from '../api.ts';

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function FilesTab({ serverId }: { serverId: string }) {
  const [root, setRoot] = useState('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string; original: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const browse = useCallback(
    async (target: string) => {
      setError(null);
      setEntries(null);
      try {
        const r = await api.files(serverId, target);
        setRoot(r.root);
        setPath(r.path);
        setEntries(r.entries);
      } catch (err) {
        setEntries([]);
        setError(
          err instanceof ApiError && typeof err.body.message === 'string'
            ? err.body.message
            : 'Could not read that folder.',
        );
      }
    },
    [serverId],
  );

  useEffect(() => {
    void browse('');
  }, [browse]);

  async function openFile(entry: FileEntry) {
    setError(null);
    setSaved(null);
    try {
      const r = await api.readFile(serverId, entry.path);
      setOpen({ path: entry.path, content: r.content, original: r.content });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not open that file.',
      );
    }
  }

  async function createFile() {
    setBusy(true);
    setError(null);
    try {
      const target = `${path}/${newName.trim()}`;
      const r = await api.createFile(serverId, target);
      setNewName('');
      await browse(path);
      const content = await api.readFile(serverId, r.path);
      setOpen({ path: r.path, content: content.content, original: content.content });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not create that file.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.uploadFile(serverId, path, file);
      setSaved(`Uploaded ${r.path.split('/').pop()}${r.replaced ? ' (replaced the existing file)' : ''}`);
      await browse(path);
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Upload failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.writeFile(serverId, open.path, open.content);
      setSaved(
        r.unchanged
          ? 'Nothing changed, so nothing was written and no backup was made.'
          : r.backup
            ? `Saved. Previous version kept as ${r.backup.split('/').pop()}`
            : 'Saved.',
      );
      setOpen({ ...open, original: open.content });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Saving failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (open) {
    const dirty = open.content !== open.original;
    return (
      <>
        <button type="button" className="backlink" onClick={() => setOpen(null)}>
          ← Back to files
        </button>
        <p className="notes">
          <code>{open.path}</code>
        </p>
        <textarea
          className="editor"
          value={open.content}
          spellCheck={false}
          onChange={(e) => setOpen({ ...open, content: e.target.value })}
        />
        {saved ? <p className="hint ok">{saved}</p> : null}
        {error ? <p className="hint bad">{error}</p> : null}
        <div className="actions">
          <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-ghost" disabled={!dirty} onClick={() => setOpen({ ...open, content: open.original })}>
            Revert
          </button>
        </div>
      </>
    );
  }

  const parent = path.slice(0, path.lastIndexOf('/'));
  // At a mount root, "up" returns to the list of mounts rather than escaping it.
  const canGoUp = path !== "" && (path !== root || root !== "");

  return (
    <>
      <p className="notes">
        <code>{path || "Mounted directories"}</code>
      </p>
      {error ? <p className="hint bad">{error}</p> : null}
      {saved ? <p className="hint ok">{saved}</p> : null}

      <div className="addrow" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <input
          placeholder="new-file.cfg"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) void createFile();
          }}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={busy || !newName.trim()}
          onClick={() => void createFile()}
        >
          Create
        </button>

        <label className="btn-ghost uploadlabel">
          {busy ? 'Working…' : 'Upload a file'}
          <input
            type="file"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void uploadFile(file);
            }}
          />
        </label>
      </div>

      <ul className="filelist">
        {canGoUp ? (
          <li>
            <button type="button" className="filelink" onClick={() => void browse(path === root ? "" : parent)}>
              ↑ ..
            </button>
          </li>
        ) : null}

        {(entries ?? []).map((entry) => (
          <li key={entry.path}>
            {entry.kind === 'directory' ? (
              <button type="button" className="filelink" onClick={() => void browse(entry.path)}>
                📁 {entry.name}
              </button>
            ) : entry.editable ? (
              <button type="button" className="filelink" onClick={() => void openFile(entry)}>
                📄 {entry.name}
              </button>
            ) : (
              // Carries the same icon as an editable file, dimmed: without it
              // these rows start at a different x and the column looks ragged.
              <span className="filelink muted" title="Not a text file this editor will open">
                📄 {entry.name}
              </span>
            )}
            <span className="when">{entry.kind === 'file' ? bytes(entry.size) : ''}</span>
          </li>
        ))}
      </ul>

      {entries !== null && entries.length === 0 && !error ? <p className="empty">This folder is empty.</p> : null}
    </>
  );
}
