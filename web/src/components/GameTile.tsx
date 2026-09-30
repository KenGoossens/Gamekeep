import { useState } from 'react';
import { artworkUrl, fallbackHue, formatDuration, type GameServer } from '../api.ts';
import { linkProps } from '../router.ts';
import { StatusPill } from './StatusPill.tsx';

export function GameTile({ server }: { server: GameServer }) {
  // Artwork is best-effort: a 404 falls through to the next presentation
  // rather than leaving a broken image.
  const [failed, setFailed] = useState(false);
  const { status, players, activeJob } = server;
  const busy = Boolean(activeJob && activeJob.phase !== 'done' && activeJob.phase !== 'failed');
  const style = failed ? 'none' : server.artworkStyle;

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
          src={artworkUrl(server.id, 'poster')}
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
          <img className="iconcover" src={artworkUrl(server.id, 'icon')} alt="" loading="lazy" />
          <img
            src={artworkUrl(server.id, 'icon')}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </div>
      ) : (
        <div className="fallback" aria-hidden="true">
          {server.displayName.charAt(0).toUpperCase()}
        </div>
      )}

      <div className="tile-top">
        <StatusPill
          state={status.state}
          health={status.health}
          activeJob={activeJob}
          error={status.error}
        />
      </div>

      <div className="tile-body">
        <span className="tile-name">{server.displayName}</span>
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
