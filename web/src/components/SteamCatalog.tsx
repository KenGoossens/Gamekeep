import { useEffect, useState } from 'react';
import { ApiError, api, type Finding, type SteamAppProposal, type SteamSearch } from '../api.ts';
import { DeployWatchCard } from './DeployWatchCard.tsx';
import { Findings } from './Findings.tsx';
import { navigate } from '../router.ts';

/**
 * Any dedicated server Steam carries, browsed exactly like the Unraid tab:
 * the whole list up front, a search box that narrows it, one Configure button
 * per row. The servers GameKeepr fully understands (ports, saves, mods,
 * player counts) sort to the top, the way running servers sort first
 * everywhere else.
 *
 * The list ships with GameKeepr — Valve retired the only complete live source
 * — and is topped up by the live store search and by pasting an app id or
 * store URL, which works for anything, listed or not.
 */

function explain(err: unknown, fallback: string): string {
  return err instanceof ApiError && typeof err.body.message === 'string'
    ? err.body.message
    : fallback;
}

export function SteamCatalog() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SteamSearch | null>(null);
  const [proposal, setProposal] = useState<SteamAppProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.steamSearch(query).then(setSearch, () => setError('Could not search Steam.'));
    }, 250);
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

  if (proposal) {
    return <SteamDeployForm proposal={proposal} onCancel={() => setProposal(null)} />;
  }

  return (
    <>
      <div className="addrow" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <input
          placeholder="Search, or paste an app id / store URL for anything not listed…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>

      {error ? <div className="banner">{error}</div> : null}
      {!search ? <p className="empty">Loading…</p> : null}

      {search?.appId ? (
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void open(search.appId!)}
        >
          {busy ? 'Reading app info…' : `Inspect Steam app ${search.appId}`}
        </button>
      ) : null}

      <ul className="catalog">
        {(search?.results ?? []).map((r) => (
          <li key={r.appId}>
            {/* The tool's own Steam client icon, baked into the shipped
                list; the few without one keep the lettered tile. */}
            {r.iconUrl ? (
              <img
                src={r.iconUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  // A dead CDN entry falls back to the lettered tile.
                  (e.target as HTMLImageElement).style.display = 'none';
                  ((e.target as HTMLImageElement).nextElementSibling as HTMLElement | null)?.style.removeProperty('display');
                }}
              />
            ) : null}
            {r.iconUrl ? (
              <div className="noicon" aria-hidden="true" style={{ display: 'none' }}>
                {r.name.slice(0, 1)}
              </div>
            ) : (
              <div className="noicon" aria-hidden="true">
                {r.name.slice(0, 1)}
              </div>
            )}
            <div className="catalog-body">
              <span className="uname">{r.name}</span>
              <span className="hint">Steam app {r.appId}</span>
              <p className="catalog-overview">
                {r.known
                  ? `GameKeepr knows this game (${r.known}): required ports are prefilled, and backups, mods and the player count work out of the box.`
                  : 'Not in the game registry — check the proposed start command and add the ports its documentation names.'}
              </p>
            </div>
            {r.known ? <span className="pill ok">full support</span> : null}
            {r.os === 'windows' ? (
              <span className="pill warn" title="Steam publishes no Linux build; GameKeepr runs the Windows server through Wine.">
                Windows-only · Wine
              </span>
            ) : null}
            {r.os === 'none' ? (
              <span className="pill bad" title="Steam publishes neither a Linux nor a Windows build of this app.">
                no server build
              </span>
            ) : null}
            <button
              type="button"
              className="btn-primary small"
              disabled={busy}
              onClick={() => void open(r.appId)}
            >
              Configure
            </button>
          </li>
        ))}
      </ul>
      {search && search.results.length === 0 && !search.appId ? (
        <p className="empty">
          Nothing matched. Newer servers may not be in the shipped list yet — paste the app id from
          the game’s SteamDB page and it works all the same.
        </p>
      ) : null}
      {search && !query.trim() ? (
        <p className="hint">
          {search.total} dedicated servers, from Steam’s last complete app list ({search.snapshotDate}).
          Newer ones are found through search when they have a store page, and pasting an app id
          always works.
        </p>
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
  const [name, setName] = useState(
    info.name
      .replace(/\s*dedicated\s*server\s*/i, '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 32) || `app-${info.appId}`,
  );
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
  const [deployed, setDeployed] = useState<{ serverId: string; watchId: string | null } | null>(null);
  // The preflight's verdicts: seeded with the login judgement from the app
  // inspection, replaced by whatever the deploy gate answers.
  const [findings, setFindings] = useState<Finding[]>(proposal.login ? [proposal.login] : []);
  const [acknowledged, setAcknowledged] = useState(false);

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
        acknowledge: acknowledged,
      });
      setSteps(result.steps);
      // No auto-navigate any more: the watch card below follows the first
      // boot, and leaving mid-verification is the operator's own choice.
      setDeployed({ serverId: result.serverId, watchId: result.watchId });
    } catch (err) {
      // The gate's findings land on screen in the same shape the Unraid tab
      // uses; a 428 arms the next press to proceed acknowledged.
      if (err instanceof ApiError && Array.isArray(err.body.findings)) {
        setFindings(err.body.findings as Finding[]);
      }
      if (err instanceof ApiError && err.body.error === 'needs-acknowledgement') {
        setAcknowledged(true);
        setError('Check the warnings below — press deploy again to proceed anyway.');
      } else {
        setError(explain(err, 'The deploy failed.'));
      }
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
        Composed by GameKeepr on the <code>{proposal.image}</code> image: SteamCMD downloads app{' '}
        {info.appId} on first start
        {info.sizeMB
          ? ` (~${info.sizeMB >= 1024 ? `${(info.sizeMB / 1024).toFixed(1)} GB` : `${info.sizeMB} MB`})`
          : ''}
        , then the start command below runs as an unprivileged user
        {proposal.platform === 'windows' ? ' — through Wine, since this server is a Windows program' : ''}
        . The generated script lands in the server’s own files, where you can read and edit it
        later.
      </p>
      {proposal.known ? (
        <p className="hint ok">
          GameKeepr knows this game ({proposal.known.label}): required ports are prefilled, and
          backups, mods and the player count will work out of the box.
        </p>
      ) : null}
      {proposal.warnings.map((w) => (
        <p className="hint bad" key={w}>
          {w}
        </p>
      ))}
      {findings.length > 0 ? <Findings findings={findings} /> : null}

      <label className="field">
        <span>Server name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>
          Start command{' '}
          <code className="fieldkey">
            {proposal.command ? 'from Steam’s own app info' : 'optional'}
          </code>
        </span>
        <input
          value={command}
          placeholder="empty = find the server’s own start script on first boot"
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          onChange={(e) => setCommand(e.target.value)}
        />
        <span className="fieldhelp">
          Runs inside the install directory. Left empty, GameKeepr looks for the server’s own
          conventional start script (startserver.sh and friends) after the download — and refuses
          loudly instead of guessing when it finds none. When a server misbehaves, the game’s own
          wiki usually documents the right headless command — edit it here or later in the Files
          tab.
        </span>
      </label>

      <label className="field">
        <span>Extra start parameters (GAME_PARAMS)</span>
        <input value={gameParams} onChange={(e) => setGameParams(e.target.value)} />
      </label>

      <h3 className="subhead">Ports</h3>
      {ports.length === 0 ? (
        <p className="hint">
          No ports known for this game. Add the ones its documentation names — without them nobody
          can join from outside.
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
          onChange={(e) =>
            setNewPort((prev) => ({ ...prev, protocol: e.target.value as 'udp' | 'tcp' }))
          }
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
          <p>Deployed — the first start is downloading the server now.</p>
          <ul className="feed">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {deployed ? (
        <>
          <DeployWatchCard
            watchId={deployed.watchId}
            serverId={deployed.serverId}
            serverName={name.trim()}
          />
          <div className="actions">
            <button type="button" className="btn-ghost" onClick={() => navigate(`/servers/${deployed.serverId}`)}>
              Open the server page
            </button>
          </div>
        </>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !proposal.platform || !name.trim() || steps !== null}
          onClick={() => void deploy()}
        >
          {busy
            ? 'Deploying…'
            : proposal.platform === 'windows'
              ? 'Deploy (runs through Wine)'
              : proposal.platform
                ? 'Deploy'
                : 'No Linux or Windows build — cannot deploy'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Back
        </button>
      </div>
    </section>
  );
}
