import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type PortForwardState } from '../api.ts';
import { linkProps } from '../router.ts';

/** Written as a constant so the newline survives every layer of tooling. */
const LINE_BREAK = String.fromCharCode(10);

export function NetworkTab({ serverId, isOwner }: { serverId: string; isOwner: boolean }) {
  const [state, setState] = useState<PortForwardState | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api.portForwards(serverId);
      setState(next);
      // Game ports are pre-selected; anything administrative never is.
      setChosen(new Set(next.missing.filter((m) => !m.sensitive).map((m) => m.port)));
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not read the router rules.',
      );
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openPorts() {
    setBusy(true);
    setError(null);
    try {
      await api.openPortForwards(serverId, [...chosen]);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Opening the ports failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <p className="empty">{error ?? 'Loading…'}</p>;

  const { needed, missing, rules, configured, target, publicAddress } = state;
  const isMissing = (port: string) => missing.some((m) => m.port === port);

  return (
    <>
      <p className="notes">
        Players connect straight to the game, not through this portal, so each game port has to be
        forwarded on the router to <code>{target}</code>.
      </p>

      {/* The two halves of the answer together: forwards point at the LAN
          address, but what you give a friend is the public one. Having only
          the first meant looking the second up somewhere else. */}
      <dl className="addresses">
        <div>
          <dt>Friends connect to</dt>
          <dd>
            {publicAddress.ip ? (
              <code>{publicAddress.ip}</code>
            ) : (
              <span className="muted-inline">not found</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Forwards point at</dt>
          <dd>{target ? <code>{target}</code> : <span className="muted-inline">not set</span>}</dd>
        </div>
      </dl>
      <p className="hint">
        {publicAddress.ip
          ? `This is your router's address as ${publicAddress.source} sees it. Most home connections keep it for a long time, but it is not guaranteed to stay — check here if friends suddenly cannot connect.`
          : `Could not be looked up${publicAddress.error ? `: ${publicAddress.error}` : ''}.`}
      </p>

      <ul className="filelist">
        {needed.map((n) => {
          const open = !isMissing(n.port);
          return (
            <li key={`${n.proto}-${n.port}`}>
              {!open && configured ? (
                <input
                  type="checkbox"
                  checked={chosen.has(n.port)}
                  onChange={(e) =>
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(n.port);
                      else next.delete(n.port);
                      return next;
                    })
                  }
                  aria-label={`Open port ${n.port}`}
                />
              ) : null}

              <span className={open ? 'pill ok' : 'pill bad'}>
                <span className="dot" />
                {open ? 'forwarded' : 'closed'}
              </span>

              <span className="filelink">
                {n.proto.toUpperCase().replace('_', '+')} {n.port}
                {n.sensitive ? (
                  <span className="hint bad"> — {n.reason}, keep this closed unless you mean it</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {error ? <p className="hint bad">{error}</p> : null}

      {!configured ? (
        <div className="handout">
          <p>
            <strong>No router is connected, so these rules have to be made by hand.</strong> Open
            your router's port-forwarding page and add:
          </p>
          <code className="secret">
            {needed
              .filter((n) => !n.sensitive)
              .map(
                (n) =>
                  `${n.proto.toUpperCase().replace('_', '+')} ${n.port} -> ${target || '<this machine>'}:${n.port}`,
              )
              .join(LINE_BREAK)}
          </code>
          <div className="row">
            <button
              type="button"
              className="btn-ghost"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  needed
                    .filter((n) => !n.sensitive)
                    .map((n) => `${n.proto.toUpperCase().replace('_', '+')} ${n.port} -> ${target}:${n.port}`)
                    .join(LINE_BREAK),
                )
              }
            >
              Copy
            </button>
            {isOwner ? (
              <a className="btn-primary" {...linkProps('/settings')}>
                Connect a router instead
              </a>
            ) : null}
          </div>
          {needed.some((n) => n.sensitive) ? (
            <p className="hint">
              Left out on purpose:{' '}
              {needed.filter((n) => n.sensitive).map((n) => `${n.port} (${n.reason})`).join(', ')}.
              Forward those only if you really mean to expose them.
            </p>
          ) : null}
          {!target ? (
            <p className="hint bad">
              Set LAN_ADDRESS in .env so the portal knows which machine to point you at.
            </p>
          ) : null}
        </div>
      ) : missing.length > 0 ? (
        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || chosen.size === 0}
            onClick={() => {
              const risky = needed.filter((n) => chosen.has(n.port) && n.sensitive);
              const warning =
                risky.length > 0
                  ? `You are about to expose ${risky.map((r) => `${r.port} (${r.reason})`).join(', ')} to the internet. Continue?`
                  : `Open ${chosen.size} port${chosen.size === 1 ? '' : 's'} to the internet?`;
              if (confirm(warning)) void openPorts();
            }}
          >
            {busy ? 'Opening…' : `Open ${chosen.size} selected port${chosen.size === 1 ? '' : 's'}`}
          </button>
        </div>
      ) : (
        <p className="hint ok">Every port this server needs is already forwarded.</p>
      )}

      {rules.length > 0 ? (
        <>
          <h3 className="section-title">Rules on the router</h3>
          <ul className="filelist">
            {rules.map((r) => (
              <li key={r.id}>
                <span className="filelink">
                  {r.name} — {r.proto.toUpperCase().replace('_', '+')} {r.dstPort} → {r.fwd}:{r.fwdPort}
                </span>
                {r.managed ? (
                  <button
                    type="button"
                    className="btn-ghost small danger"
                    disabled={busy}
                    onClick={async () => {
                      if (!confirm(`Remove "${r.name}"? The server becomes unreachable from outside.`)) return;
                      setBusy(true);
                      try {
                        await api.closePortForward(serverId, r.id);
                        await load();
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <span className="hint">yours — not touched</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
