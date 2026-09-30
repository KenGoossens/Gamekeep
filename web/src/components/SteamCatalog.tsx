import { useEffect, useState } from 'react';
import { ApiError, api, type SteamAppProposal, type SteamSearch } from '../api.ts';
import { navigate } from '../router.ts';

/**
 * Any dedicated server Steam carries, from a container the portal composes.
 *
 * The screen is honest about its three routes. With a Steam Web API key the
 * search covers the whole catalogue; without one it covers the servers that
 * have store pages; and pasting an app id or store URL always works, key or
 * no key. The deploy form's centrepiece is the start command — the one thing
 * between Valve's image and Steam's depots that Gamekeep wrote itself, shown
 * before anything exists rather than discovered after.
 */

function explain(err: unknown, fallback: string): string {
  return err instanceof ApiError && typeof err.body.message === 'string'
    ? err.body.message
    : fallback;
}

export function SteamCatalog({ isOwner }: { isOwner: boolean }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SteamSearch | null>(null);
  const [proposal, setProposal] = useState<SteamAppProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyNote, setKeyNote] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.steamSearch(query).then(setSearch, () => setError('Could not search Steam.'));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function open(appId: number) {
    setBusy(true);
    setError(null);
    try {
      setProposal(await api.steamApp(appId));
    } catch (err) {
      setError(explain(err, 'Could not read that app from Steam.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    setKeyNote(null);
    try {
      await api.setSteamKey(keyInput.trim());
      setKeyInput('');
      const { count } = await api.refreshSteamCatalog();
      setKeyNote(`Key saved; found ${count} dedicated servers on Steam.`);
      setSearch(await api.steamSearch(query));
    } catch (err) {
      setKeyNote(explain(err, 'Could not save the key.'));
    } finally {
      setBusy(false);
    }
  }

  if (proposal) {
    return <SteamDeployForm proposal={proposal} onCancel={() => setProposal(null)} />;
  }

  return (
    <>
      <div className="addrow" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <input
          placeholder="Search Steam, or paste an app id / store URL…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {search && !search.haveKey ? (
        <div className="hint">
          <p style={{ margin: '4px 0' }}>
            Without a Steam Web API key the search only sees servers with a store page — most
            dedicated server tools have none. Pasting an app id or URL always works.
            {isOwner ? ' A key is free at steamcommunity.com/dev/apikey:' : ' Ask the owner to add a key for the full catalogue.'}
          </p>
          {isOwner ? (
            <div className="addrow" style={{ marginTop: 6, paddingTop: 0, borderTop: 0 }}>
              <input
                placeholder="Steam Web API key (32 hex characters)"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || keyInput.trim().length !== 32}
                onClick={() => void saveKey()}
              >
                Save & fetch catalogue
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {search?.haveKey && search.cachedCount > 0 ? (
        <p className="hint">
          Searching {search.cachedCount.toLocaleString()} dedicated servers known to Steam
          {search.stale ? ' (list is over a week old — the owner can refresh it)' : ''}.
        </p>
      ) : null}
      {keyNote ? <p className="hint ok">{keyNote}</p> : null}
      {error ? <p className="hint bad">{error}</p> : null}

      {search?.appId ? (
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void open(search.appId!)}>
          {busy ? 'Reading app info…' : `Inspect Steam app ${search.appId}`}
        </button>
      ) : null}

      <ul className="modlist">
        {(search?.results ?? []).map((r) => (
          <li key={r.appId}>
            <span className="mod-name">
              {r.name} <span className="mod-version">{r.appId}</span>
            </span>
            <span className="mod-meta">
              {r.known ? `Gamekeep knows this game (${r.known}): ports, saves and mods light up automatically` : 'Unknown to the registry — ports and the start command need a check'}
            </span>
            <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void open(r.appId)}>
              Configure
            </button>
          </li>
        ))}
      </ul>
      {search && query.trim().length >= 2 && search.results.length === 0 && !search.appId ? (
        <p className="empty">Nothing matched. Try the app id from the game’s SteamDB page.</p>
      ) : null}
    </>
  );
}

function SteamDeployForm({
  proposal,
  onCancel,
}: {
  proposal: SteamAppProposal;
  onCancel: () => void;
}) {
  const { info } = proposal;
  const [name, setName] = useState(info.name.replace(/\s*dedicated\s*server\s*/i, '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 32) || `app-${info.appId}`);
  const [command, setCommand] = useState(proposal.command);
  const [gameParams, setGameParams] = useState('');
  const [validate, setValidate] = useState(false);
  const [ports, setPorts] = useState(proposal.ports.map((p) => ({ ...p })));
  const [newPort, setNewPort] = useState({ container: '', protocol: 'udp' as 'udp' | 'tcp' });
  const [steamUser, setSteamUser] = useState('');
  const [steamPass, setSteamPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.steamDeploy({
        appId: info.appId,
        name: name.trim(),
        command: command.trim(),
        ports: ports.map((p) => ({ container: p.container, host: p.host, protocol: p.protocol })),
        gameParams: gameParams.trim() || undefined,
        validate,
        steamUsername: steamUser.trim() || undefined,
        steamPassword: steamPass || undefined,
      });
      setSteps(result.steps);
      setTimeout(() => navigate(`/servers/${result.serverId}`), 2500);
    } catch (err) {
      setError(explain(err, 'The deploy failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          {info.name} <span className="mod-version">Steam app {info.appId}</span>
        </h2>
      </div>

      <p className="notes">
        Composed by Gamekeep on Valve’s official <code>{proposal.image}</code> image: SteamCMD
        downloads app {info.appId} on first start
        {info.sizeMB ? ` (~${info.sizeMB >= 1024 ? `${(info.sizeMB / 1024).toFixed(1)} GB` : `${info.sizeMB} MB`})` : ''}, then the start
        command below runs as an unprivileged user. The generated script lands in the server’s own
        files, where you can read and edit it later.
      </p>
      {proposal.known ? (
        <p className="hint ok">
          Gamekeep knows this game ({proposal.known.label}): required ports are prefilled, and
          backups, mods and the player count will work out of the box.
        </p>
      ) : null}
      {proposal.warnings.map((w) => (
        <p className="hint bad" key={w}>
          {w}
        </p>
      ))}

      <label className="field">
        <span>Server name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>
          Start command <code className="fieldkey">from Steam’s own app info</code>
        </span>
        <input
          value={command}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          onChange={(e) => setCommand(e.target.value)}
        />
        <span className="fieldhelp">
          Runs inside the install directory. When a server misbehaves, the game’s own wiki usually
          documents the right headless command — edit it here or later in the Files tab.
        </span>
      </label>

      <label className="field">
        <span>Extra start parameters (GAME_PARAMS)</span>
        <input value={gameParams} onChange={(e) => setGameParams(e.target.value)} />
      </label>

      <h3 className="subhead">Ports</h3>
      {ports.length === 0 ? (
        <p className="hint">
          No ports known for this game. Add the ones its documentation names, or deploy without and
          add them later by recreating — the Network tab will say what is missing if Gamekeep
          learns this game.
        </p>
      ) : null}
      <ul className="modlist">
        {ports.map((p, i) => (
          <li key={`${p.container}/${p.protocol}`}>
            <span className="mod-name">
              <code>
                {p.container}/{p.protocol}
              </code>
            </span>
            {'purpose' in p && p.purpose ? <span className="mod-meta">{p.purpose}</span> : null}
            <button
              type="button"
              className="btn-ghost small danger"
              onClick={() => setPorts((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="addrow">
        <input
          type="number"
          min={1}
          max={65535}
          placeholder="Port"
          value={newPort.container}
          style={{ flex: 'none', width: '8rem' }}
          onChange={(e) => setNewPort((prev) => ({ ...prev, container: e.target.value }))}
        />
        <select
          value={newPort.protocol}
          onChange={(e) => setNewPort((prev) => ({ ...prev, protocol: e.target.value as 'udp' | 'tcp' }))}
        >
          <option value="udp">udp</option>
          <option value="tcp">tcp</option>
        </select>
        <button
          type="button"
          className="btn-ghost"
          disabled={!newPort.container}
          onClick={() => {
            const n = Number(newPort.container);
            if (!Number.isInteger(n) || n < 1 || n > 65535) return;
            setPorts((prev) =>
              prev.some((p) => p.container === n && p.protocol === newPort.protocol)
                ? prev
                : [...prev, { container: n, host: n, protocol: newPort.protocol, purpose: '' }],
            );
            setNewPort({ container: '', protocol: 'udp' });
          }}
        >
          Add port
        </button>
      </div>

      <details style={{ margin: '12px 0' }}>
        <summary className="hint" style={{ cursor: 'pointer' }}>
          Steam login — only for the few servers that refuse anonymous downloads
        </summary>
        <label className="field">
          <span>Steam username</span>
          <input value={steamUser} onChange={(e) => setSteamUser(e.target.value)} />
        </label>
        <label className="field">
          <span>Steam password</span>
          <input type="password" value={steamPass} onChange={(e) => setSteamPass(e.target.value)} />
          <span className="fieldhelp">
            Stored on the container like any other variable. Accounts with Steam Guard need an
            app-specific flow; most dedicated servers simply allow anonymous.
          </span>
        </label>
      </details>

      <label className="checkline" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} />
        verify game files on every start (slower, thorough)
      </label>

      {error ? <p className="hint bad">{error}</p> : null}
      {steps ? (
        <div className="handout">
          <p>Deployed — first start is downloading the server now. Opening its page…</p>
          <ul className="feed">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !info.linux || !command.trim() || !name.trim() || steps !== null}
          onClick={() => void deploy()}
        >
          {busy ? 'Deploying…' : info.linux ? 'Deploy' : 'No Linux build — cannot deploy'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Back
        </button>
      </div>
    </section>
  );
}
