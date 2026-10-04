import { useState } from 'react';
import { ApiError, api, artworkUrl, fallbackHue, formatDuration, type GameServer } from '../api.ts';
import { linkProps } from '../router.ts';
import { StatusPill } from './StatusPill.tsx';

export function GameTile({ server }: { server: GameServer }) {
  // Artwork is best-effort: a 404 falls through to the next presentation
  // rather than leaving a broken image.
  const [failed, setFailed] = useState(false);
  // Optimistic: the server list refreshes on its own poll, and waiting five
  // seconds to see your own rename land makes the button feel broken.
  const [renamed, setRenamed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const { status, players, activeJob } = server;
  const busy = Boolean(activeJob && activeJob.phase !== 'done' && activeJob.phase !== 'failed');
  const style = failed ? 'none' : server.artworkStyle;
  const displayName = renamed ?? server.displayName;

  const canOperate =
    !server.transient && (server.yourAccess === 'owner' || server.yourAccess === 'operator');
  const isOwner = !server.transient && server.yourAccess === 'owner';
  const artId = server.artworkId ?? server.id;

  if (gone) return null;

  async function rename(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const next = prompt('New name for this server:', displayName)?.trim();
    if (!next || next === displayName) return;
    try {
      const result = await api.renameServer(server.id, next);
      setRenamed(result.displayName);
    } catch (err) {
      alert(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not rename it.',
      );
    }
  }

  async function remove(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (
      !confirm(
        `Delete ${displayName}? The container is stopped and removed. The game's data and backups stay on disk.`,
      )
    )
      return;
    try {
      await api.deleteServer(server.id);
      setGone(true);
    } catch (err) {
      alert(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not delete it.',
      );
    }
  }

  return (
    <a
      {...linkProps(`/servers/${encodeURIComponent(server.id)}`)}
      className={`tile${status.running || busy ? '' : ' stopped'}`}
      style={
        {
          '--hue': fallbackHue(server.id),
          '--tile-accent': server.accent ?? undefined,
        } as React.CSSProperties
      }
    >
      {style === 'poster' ? (
        <img
          className="poster"
          src={artworkUrl(artId, 'poster')}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : style === 'icon' ? (
        /* Not on Steam, so no poster exists. The icon serves twice: blown up
           and blurred as the card's backdrop, and sharp in the middle -- which
           reads as a full-picture card without inventing artwork the game
           never had. */
        <div className="iconart" aria-hidden="true">
          <img className="iconcover" src={artworkUrl(artId, 'icon')} alt="" loading="lazy" />
          <img
            src={artworkUrl(artId, 'icon')}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </div>
      ) : (
        <div className="fallback" aria-hidden="true">
          {displayName.charAt(0).toUpperCase()}
        </div>
      )}

      <div className="tile-top">
        <StatusPill
          state={status.state}
          health={status.health}
          activeJob={activeJob}
          error={status.error}
        />
        {server.transient ? <span className="pill plain beta-tag-pill">match</span> : null}
        {server.update?.available ? (
          <span className="pill warn beta-tag-pill" title="Steam ships a newer build — a restart installs it">
            update
          </span>
        ) : null}
        {canOperate ? (
          <span className="tile-actions">
            <button type="button" className="tile-action" title="Rename" onClick={rename}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M11.1 2.2l2.7 2.7-7.9 7.9-3.2.5.5-3.2 7.9-7.9z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="sr-only">Rename {displayName}</span>
            </button>
            {isOwner ? (
              <button type="button" className="tile-action danger" title="Delete" onClick={remove}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M3 4.5h10M6.5 2.5h3M5 4.5l.6 9h4.8l.6-9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="sr-only">Delete {displayName}</span>
              </button>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="tile-body">
        <span className="tile-name">{displayName}</span>
        <span className="tile-meta">
          {status.running && status.uptimeSeconds !== null ? (
            <span>Up {formatDuration(status.uptimeSeconds)}</span>
          ) : null}
          {players ? (
            <span>
              {players.online}
              {players.max ? `/${players.max}` : ''} online
            </span>
          ) : null}
          {!status.running && !busy ? <span>Not running</span> : null}
        </span>
      </div>
    </a>
  );
}
