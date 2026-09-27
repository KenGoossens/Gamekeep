import { useEffect, useState } from 'react';
import { api, type WorldInfo } from '../api.ts';

/** Shows the world seed when the game stores one we can read. */
export function WorldCard({ serverId }: { serverId: string }) {
  const [world, setWorld] = useState<WorldInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.world(serverId).then(
      (r) => !cancelled && setWorld(r.world),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  if (!world?.seed) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>World</h2>
        {world.name ? <span className="pill plain">{world.name}</span> : null}
      </div>

      <div className="seedrow">
        <span className="stat-label">Seed</span>
        <code className="seedvalue">{world.seed}</code>
        <button
          type="button"
          className="btn-ghost small"
          onClick={() => void navigator.clipboard?.writeText(world.seed ?? '')}
        >
          Copy
        </button>
        {world.mapUrl ? (
          <a className="btn-ghost small" href={world.mapUrl} target="_blank" rel="noreferrer noopener">
            View the map ↗
          </a>
        ) : null}
      </div>

      <p className="notes">
        Read from <code>{world.source}</code>. Anyone with this seed can generate the same world.
      </p>
    </section>
  );
}
