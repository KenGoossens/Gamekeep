import { useEffect, useState } from 'react';
import { api, type ConnectInfo } from '../api.ts';

/**
 * How to get into this server, on the overview where every member can see it.
 *
 * The password is shown in the clear on purpose: it is the game's door key,
 * and the people allowed to open this page are exactly the people it was set
 * for. Before this card existed a freshly deployed server had a password that
 * was visible to nobody — including the person who deployed it.
 */
export function ConnectCard({ serverId }: { serverId: string }) {
  const [info, setInfo] = useState<ConnectInfo | null>(null);

  useEffect(() => {
    let live = true;
    api.connectInfo(serverId).then(
      (next) => {
        if (live) setInfo(next);
      },
      () => {
        // No info is a quiet absence, never an error banner on the overview.
      },
    );
    return () => {
      live = false;
    };
  }, [serverId]);

  if (!info) return null;
  const address = info.publicAddress.ip ?? info.lanAddress;
  const rows: Array<[string, string]> = [];
  if (address) rows.push(['Address', info.port ? `${address}:${info.port}` : address]);
  if (info.name) rows.push(['Server name', info.name]);
  if (info.world) rows.push(['World', info.world]);
  if (info.password) rows.push(['Password', info.password]);
  if (rows.length === 0) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Joining</h2>
      </div>
      <dl className="addresses">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <p className="hint">
        {info.password
          ? 'Hand a friend the address and the password and they are in.'
          : 'This server has no password set.'}
      </p>
    </section>
  );
}
