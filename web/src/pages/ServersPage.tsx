import type { GameServer } from '../api.ts';
import { GameTile } from '../components/GameTile.tsx';

export function ServersPage({ servers }: { servers: GameServer[] }) {
  const running = servers.filter((s) => s.status.running).length;
  const players = servers.reduce((total, s) => total + (s.players?.online ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <h1>Servers</h1>
        <p>
          {servers.length} server{servers.length === 1 ? '' : 's'} · {running} running
          {players > 0 ? ` · ${players} player${players === 1 ? '' : 's'} online` : ''}
        </p>
      </div>

      {servers.length === 0 ? (
        <p className="empty">No servers configured yet. Add them to config/servers.json.</p>
      ) : (
        <div className="grid">
          {servers.map((server) => (
            <GameTile key={server.id} server={server} />
          ))}
        </div>
      )}
    </>
  );
}
