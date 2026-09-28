import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type WorkshopItem, type WorkshopList, type WorkshopVerdict } from '../api.ts';

/**
 * Steam Workshop mods, for the games that collect their own.
 *
 * A different screen from the repository one because it is a different thing.
 * Nothing is downloaded here and nothing is scanned: the mod's id is written
 * into the server's config and the game fetches it on the next start. Saying
 * that plainly matters, because an operator who adds a mod and sees nothing
 * change would otherwise assume it failed.
 *
 * The one real check the Workshop supports is which game an item was published
 * for, and that is stated as a fact. Everything softer -- an old mod, an
 * obscure one -- is a warning next to it, never a verdict on whether the code
 * is safe, because the portal never sees the code.
 */

function ago(iso: string | null): string {
  if (!iso) return 'unknown';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function subscribers(n: number | null): string {
  if (n === null) return '';
  if (n < 1000) return `${n} subscribers`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k subscribers`;
  return `${(n / 1_000_000).toFixed(1)}M subscribers`;
}

function Verdict({ verdict }: { verdict: WorkshopVerdict }) {
  if (verdict.reasons.length === 0 && verdict.warnings.length === 0) return null;
  return (
    <ul className="findings">
      {verdict.reasons.map((reason) => (
        <li key={reason} className="finding fail">
          {reason}
        </li>
      ))}
      {verdict.warnings.map((warning) => (
        <li key={warning} className="finding warn">
          {warning}
        </li>
      ))}
    </ul>
  );
}

function Preview({ item }: { item: WorkshopItem }) {
  return (
    <div className="plan">
      <div className="plan-head">
        <strong>{item.title}</strong>
        <span className="plan-meta">
          <a href={item.url} target="_blank" rel="noreferrer">
            Workshop page
          </a>{' '}
          · updated {ago(item.updatedAt)}
          {item.subscriptions !== null ? ` · ${subscribers(item.subscriptions)}` : ''}
        </span>
      </div>
      {item.verdict ? <Verdict verdict={item.verdict} /> : null}
      {item.declaredModIds.length > 0 ? (
        <p className="plan-hash">
          declares <code>{item.declaredModIds.join(', ')}</code>
        </p>
      ) : null}
    </div>
  );
}

export function WorkshopPanel({ serverId }: { serverId: string }) {
  const [list, setList] = useState<WorkshopList | null>(null);
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState<{ item: WorkshopItem; already: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.workshop(serverId));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not read this server’s mod list.',
      );
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

  async function lookUp() {
    if (!reference.trim()) return;
    setBusy('lookup');
    setError(null);
    setNote(null);
    setPreview(null);
    try {
      const found = await api.lookupWorkshop(serverId, reference.trim());
      setPreview({ item: { ...found.item, verdict: found.verdict }, already: found.alreadyDeclared });
    } catch (err) {
      setError(explain(err, 'Could not look that mod up.'));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    if (!preview) return;
    setBusy('add');
    setError(null);
    try {
      const result = await api.declareWorkshop(serverId, preview.item.id);
      setNote(result.message);
      setPreview(null);
      setReference('');
      await load();
    } catch (err) {
      setError(explain(err, 'Could not add that mod.'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(item: { id: string; title: string }) {
    if (!confirm(`Remove ${item.title} from this server’s mod list?`)) return;
    setBusy(item.id);
    setError(null);
    try {
      const result = await api.undeclareWorkshop(serverId, item.id);
      setNote(result.message);
      await load();
    } catch (err) {
      setError(explain(err, 'Could not remove that mod.'));
    } finally {
      setBusy(null);
    }
  }

  if (!list) return <p className="empty">{error ?? 'Loading…'}</p>;

  return (
    <>
      <p className="notes">
        This game collects its own mods. Gamekeep writes the Workshop id into{' '}
        <code>{list.file.split('/').pop()}</code> and the server downloads it on the next start —
        so nothing is scanned here, because nothing is downloaded here.
      </p>
      <p className="hint">{list.note}</p>

      {list.running ? (
        <p className="hint bad">This server is running. Stop it before changing its mod list.</p>
      ) : null}
      {error ? <p className="hint bad">{error}</p> : null}
      {note ? <p className="hint ok">{note}</p> : null}

      {/* ---- adding one ---- */}
      <h3 className="subhead">Add from the Workshop</h3>
      <div className="row">
        <input
          type="text"
          value={reference}
          placeholder="Workshop link or item id"
          disabled={list.running || busy !== null}
          onChange={(e) => setReference(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void lookUp();
          }}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={list.running || busy !== null || !reference.trim()}
          onClick={() => void lookUp()}
        >
          {busy === 'lookup' ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      <p className="hint">
        The Workshop has no open search, so paste the address of the mod’s own page.
      </p>

      {preview ? (
        <>
          <Preview item={preview.item} />
          <div className="row">
            <button
              type="button"
              className="btn-primary"
              disabled={
                busy !== null || list.running || preview.already || !preview.item.verdict?.ok
              }
              onClick={() => void add()}
            >
              {preview.already
                ? 'Already on the list'
                : busy === 'add'
                  ? 'Adding…'
                  : 'Add to this server'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {/* ---- what is declared ---- */}
      <h3 className="subhead">On this server</h3>
      {list.lookupError ? (
        <p className="hint bad">
          {list.items.length === 0 ? 'Could not reach the Steam Workshop' : 'Steam is unreachable'},
          so these are shown by id only: {list.lookupError}
        </p>
      ) : null}

      {list.items.length === 0 && list.unknown.length === 0 ? (
        <p className="empty">No Workshop mods declared.</p>
      ) : (
        <ul className="modlist">
          {list.items.map((item) => (
            <li key={item.id}>
              <span className="mod-name">
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>{' '}
                <span className="mod-version">{item.id}</span>
              </span>
              <span className="mod-meta">
                updated {ago(item.updatedAt)}
                {item.subscriptions !== null ? ` · ${subscribers(item.subscriptions)}` : ''}
                {item.declaredModIds.length > 0 ? ` · ${item.declaredModIds.join(', ')}` : ''}
              </span>
              {item.verdict && !item.verdict.ok ? <Verdict verdict={item.verdict} /> : null}
              <button
                type="button"
                className="btn-ghost small danger"
                disabled={list.running || busy !== null}
                onClick={() => void remove(item)}
              >
                {busy === item.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}

          {/* Declared here, but Steam has no such item any more. Worth seeing:
              the server will keep trying to download it on every start. */}
          {list.unknown.map((id) => (
            <li key={id}>
              <span className="mod-name">
                <span className="mod-version">{id}</span>
              </span>
              <span className="mod-meta bad">
                The Steam Workshop no longer has this item. The server will fail to download it.
              </span>
              <button
                type="button"
                className="btn-ghost small danger"
                disabled={list.running || busy !== null}
                onClick={() => void remove({ id, title: id })}
              >
                {busy === id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {list.usesModIds ? (
        <p className="hint">
          This game keeps two lists: the Workshop ids it downloads, and the mod names it then
          loads. Gamekeep maintains both — currently{' '}
          {list.modIds.length > 0 ? <code>{list.modIds.join('; ')}</code> : 'empty'}.
        </p>
      ) : null}
    </>
  );
}
