import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  artworkUrl,
  fallbackHue,
  formatDuration,
  formatRelative,
  type GameServer,
  type ServerHistoryEntry,
} from '../api.ts';
import { linkProps, navigate } from '../router.ts';
import { StatusPill } from '../components/StatusPill.tsx';
import { RestartButton } from '../components/RestartButton.tsx';
import { AdminControls } from '../components/AdminControls.tsx';
import { MetricsTab } from '../components/MetricsTab.tsx';
import { SettingsTab } from '../components/SettingsTab.tsx';
import { FilesTab } from '../components/FilesTab.tsx';
import { NetworkTab } from '../components/NetworkTab.tsx';
import { ModsTab } from '../components/ModsTab.tsx';
import { LogsTab } from '../components/LogsTab.tsx';
import { Modal } from '../components/Modal.tsx';
import { WorldCard } from '../components/WorldCard.tsx';

type Tab = 'overview' | 'metrics' | 'logs' | 'settings' | 'files' | 'mods' | 'network';

const POLL_IDLE_MS = 5000;
const POLL_BUSY_MS = 2000;

export function ServerDetailPage({
  serverId,
  canOperate,
  isOwner,
}: {
  serverId: string;
  canOperate: boolean;
  isOwner: boolean;
}) {
  const [server, setServer] = useState<GameServer | null>(null);
  const [history, setHistory] = useState<ServerHistoryEntry[]>([]);
  const [missing, setMissing] = useState(false);
  const [heroOk, setHeroOk] = useState(true);
  const [logoOk, setLogoOk] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<Tab>('overview');
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      if (document.hidden) {
        timer = window.setTimeout(tick, POLL_IDLE_MS);
        return;
      }
      try {
        const data = await api.server(serverId);
        if (cancelled) return;
        setServer(data.server);
        setHistory(data.history);
        const job = data.server.activeJob;
        const busy = Boolean(job && job.phase !== 'done' && job.phase !== 'failed');
        timer = window.setTimeout(tick, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setMissing(true);
          return;
        }
        timer = window.setTimeout(tick, POLL_IDLE_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [serverId, nonce]);

  if (missing) {
    return (
      <>
        <a {...linkProps('/servers')} className="backlink">
          ← Servers
        </a>
        <p className="empty">That server is not configured.</p>
      </>
    );
  }

  if (!server) return null;

  const { status, players } = server;
  const style = heroOk ? server.artworkStyle : 'none';

  return (
    <>
      <a {...linkProps('/servers')} className="backlink">
        ← Servers
      </a>

      <header
        className="hero"
        style={{ '--hue': fallbackHue(server.id) } as React.CSSProperties}
      >
        {style === 'poster' ? (
          <img
            className="heroart"
            src={artworkUrl(server.id, 'hero')}
            alt=""
            onError={() => setHeroOk(false)}
          />
        ) : (
          <div className="fallback herofallback" aria-hidden="true" />
        )}

        <div className="hero-body">
          {style === 'poster' && logoOk ? (
            <img
              className="gamelogo"
              src={artworkUrl(server.id, 'logo')}
              alt={server.displayName}
              onError={() => setLogoOk(false)}
            />
          ) : style === 'icon' && logoOk ? (
            <div className="heroicon">
              <img
                src={artworkUrl(server.id, 'icon')}
                alt=""
                onError={() => setLogoOk(false)}
              />
              <h1>{server.displayName}</h1>
            </div>
          ) : (
            <h1>{server.displayName}</h1>
          )}

          <div className="statrow">
            <StatusPill
              state={status.state}
              health={status.health}
              activeJob={server.activeJob}
              error={status.error}
            />
            <span>
              <span className="stat-label">Uptime</span>
              <strong>
                {status.running && status.uptimeSeconds !== null
                  ? formatDuration(status.uptimeSeconds)
                  : '—'}
              </strong>
            </span>
            <span>
              <span className="stat-label">Players</span>
              <strong>
                {players ? `${players.online}${players.max ? `/${players.max}` : ''}` : '—'}
              </strong>
            </span>
            {players?.map ? (
              <span>
                <span className="stat-label">World</span>
                <strong>{players.map}</strong>
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <nav className="tabs">
        {(
          [
            ['overview', 'Overview', false],
            ['metrics', 'Performance', false],
            ...(canOperate
              ? ([
                  // Logs are most useful precisely while the server runs, so
                  // unlike the tabs below this one is never locked.
                  ['logs', 'Logs', false],
                  ['settings', 'Settings', true],
                  ['files', 'Files', true],
                  ['mods', 'Mods', true],
                  ['network', 'Network', false],
                ] as Array<[Tab, string, boolean]>)
              : []),
          ] as Array<[Tab, string, boolean]>
        ).map(([key, label, needsStopped]) => {
          const locked = needsStopped && status.running;
          return (
            <button
              key={key}
              type="button"
              className={tab === key ? 'tab active' : 'tab'}
              aria-disabled={locked}
              onClick={() => (locked ? setBlocked(label) : setTab(key))}
            >
              {label}
              {locked ? " · locked" : null}
            </button>
          );
        })}
      </nav>

      {blocked ? (
        <Modal
          title={`Stop the server to change ${blocked.toLowerCase()}`}
          onClose={() => setBlocked(null)}
          actions={
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setBlocked(null);
                setTab('overview');
              }}
            >
              Go to controls
            </button>
          }
        >
          <p>
            <strong>{server.displayName}</strong> is running. Changing settings or files while it
            runs does not work reliably: most game servers hold their configuration in memory and
            write it back when they shut down, quietly undoing your edit.
          </p>
          <p>Stop the server first, make your change, then start it again.</p>
        </Modal>
      ) : null}
      {tab === 'metrics' ? (
        <section className="card">
          <MetricsTab serverId={server.id} />
        </section>
      ) : null}

      {tab === 'settings' && canOperate ? (
        <section className="card">
          <div className="card-head">
            <h2>Server settings</h2>
          </div>
          <SettingsTab serverId={server.id} onChanged={refresh} />
        </section>
      ) : null}

      {tab === 'network' && canOperate ? (
        <section className="card">
          <div className="card-head">
            <h2>Reachability</h2>
          </div>
          <NetworkTab serverId={server.id} isOwner={isOwner} />
        </section>
      ) : null}

      {tab === 'logs' && canOperate ? (
        <section className="card">
          <div className="card-head">
            <h2>Logs</h2>
          </div>
          <LogsTab serverId={server.id} />
        </section>
      ) : null}

      {tab === 'mods' && canOperate ? (
        <section className="card">
          <div className="card-head">
            <h2>Mods</h2>
          </div>
          <ModsTab serverId={server.id} />
        </section>
      ) : null}

      {tab === 'files' && canOperate ? (
        <section className="card">
          <div className="card-head">
            <h2>Files</h2>
          </div>
          <FilesTab serverId={server.id} />
        </section>
      ) : null}

      {tab !== 'overview' ? null : (
      <>
      <WorldCard serverId={server.id} />
      <section className="card">
        <div className="card-head">
          <h2>Controls</h2>
        </div>
        {server.notes ? <p className="notes">{server.notes}</p> : null}
        <RestartButton server={server} onAction={refresh} />
        {canOperate ? <AdminControls server={server} onAction={refresh} /> : null}
      </section>

      {players && players.names.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>Online now</h2>
            <span className="pill plain">{players.names.length}</span>
          </div>
          <ul className="feed">
            {players.names.map((name) => (
              <li key={name}>
                <strong>{name}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>History</h2>
        </div>
        {history.length === 0 ? (
          <p className="empty">Nothing recorded for this server yet.</p>
        ) : (
          <ul className="feed">
            {history.map((entry) => (
              <li key={entry.id}>
                <span>
                  <strong>{entry.username}</strong>{' '}
                  {entry.result === 'success'
                    ? 'restarted it'
                    : entry.result === 'unconfirmed'
                      ? 'restarted it, but it did not respond in time'
                      : entry.result === 'cooldown'
                        ? 'tried during the cooldown'
                        : entry.result === 'busy'
                          ? 'tried while it was already restarting'
                          : 'failed to restart it'}
                  {entry.detail ? <span className="hint"> — {entry.detail}</span> : null}
                </span>
                <span className="when">{formatRelative(entry.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      </>
      )}

      <button type="button" className="btn-ghost" onClick={() => navigate('/servers')}>
        Back to all servers
      </button>
    </>
  );
}
