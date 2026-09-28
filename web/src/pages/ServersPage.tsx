import { useMemo, useState } from 'react';
import type { GameServer } from '../api.ts';
import { GameTile } from '../components/GameTile.tsx';
import { byRunningThenName, matchesSearch } from '../ordering.ts';

export function ServersPage({ servers }: { servers: GameServer[] }) {
  const [search, setSearch] = useState('');

  const running = servers.filter((s) => s.status.running).length;
  const players = servers.reduce((total, s) => total + (s.players?.online ?? 0), 0);

  const shown = useMemo(
    () =>
      servers
        .filter((s) =>
          matchesSearch(search, { name: s.displayName, game: s.id, notes: s.notes }),
        )
        .slice()
        .sort((a, b) =>
          byRunningThenName(
            { running: a.status.running, name: a.displayName },
            { running: b.status.running, name: b.displayName },
          ),
        ),
    [servers, search],
  );

  return (
    <>
      <div className="page-head command-head">
        <div>
          <h1>Servers</h1>
          <p>
            {servers.length} server{servers.length === 1 ? '' : 's'} · {running} running
            {players > 0 ? ` · ${players} player${players === 1 ? '' : 's'} online` : ''}
          </p>
        </div>

        {/* Only once there are enough servers for finding one to be work. */}
        {servers.length > 3 ? (
          <input
            className="modsearch serversearch"
            type="search"
            value={search}
            placeholder="Find a server…"
            aria-label="Find a server"
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}
      </div>

      {servers.length === 0 ? (
        <p className="empty">No servers configured yet. Add them to config/servers.json.</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nothing matches “{search.trim()}”.</p>
      ) : (
        <div className="grid">
          {shown.map((server) => (
            <GameTile key={server.id} server={server} />
          ))}
        </div>
      )}
    </>
  );
}
