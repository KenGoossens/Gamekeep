import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Dashboard, type DashboardServer } from '../api.ts';
import { TimeChart, type ChartSeries } from '../components/TimeChart.tsx';
import { linkProps } from '../router.ts';

/**
 * The fleet at a glance.
 *
 * Built to be read from across a room, which is what drives the layout: the
 * numbers that answer "is anything wrong right now" are large and first, the
 * history that answers "has it been wrong for a while" sits under them, and
 * the detail lives one click away on each server's own page.
 *
 * The chart colours are a validated categorical palette, not the theme
 * accents: the theme's greens and ambers are status colours and stay reserved
 * for status, and its accents fail the lightness band and the colour-vision
 * separation checks when used as series. Every series is also labelled
 * directly, so identity never rests on colour alone.
 */
const SERIES_COLOURS = ['#3987e5', '#d95926', '#1b9488', '#b06fd8', '#ab8a1f'];

/** Beyond this, lines stop being readable and the chart starts lying by clutter. */
const MAX_SERIES = SERIES_COLOURS.length;

const WINDOWS = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 24 * 3_600_000 },
  { label: '7d', ms: 7 * 86_400_000 },
];

function bytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

function uptime(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A large number with its label, the thing read first. */
function Stat({
  value,
  label,
  sub,
  tone = 'plain',
}: {
  value: string;
  label: string;
  sub?: string;
  tone?: 'plain' | 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/** One server, with just enough to decide whether to open it. */
function ServerTile({ server, colour }: { server: DashboardServer; colour: string }) {
  const tone = server.running ? (server.health === 'unhealthy' ? 'warn' : 'ok') : 'bad';
  return (
    <a className="fleet-tile" {...linkProps(`/servers/${server.id}`)}>
      <span className="fleet-bar" style={{ background: colour }} aria-hidden="true" />
      <span className="fleet-head">
        <span className={`fleet-dot fleet-${tone}`} aria-hidden="true" />
        <span className="fleet-name">{server.displayName}</span>
        <span className={`fleet-state fleet-${tone}`}>{server.running ? 'running' : server.state}</span>
      </span>
      <dl className="fleet-facts">
        <div>
          <dt>Players</dt>
          <dd>
            {server.players ? `${server.players.online}${server.players.max ? ` / ${server.players.max}` : ''}` : '—'}
          </dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{uptime(server.uptimeSeconds)}</dd>
        </div>
        <div>
          <dt>CPU</dt>
          <dd>{server.cpuPercent === null ? '—' : `${server.cpuPercent.toFixed(0)}%`}</dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>{bytes(server.memBytes)}</dd>
        </div>
      </dl>
    </a>
  );
}

export function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [windowMs, setWindowMs] = useState(6 * 3_600_000);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard(windowMs));
      setError(null);
    } catch {
      setError('Could not read the dashboard.');
    }
  }, [windowMs]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  /*
   * Colour follows the server, never its position in a filtered list: a
   * server that stops must not hand its colour to the next one along.
   */
  const colourOf = useMemo(() => {
    const order = [...(data?.servers ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const map = new Map<string, string>();
    order.forEach((s, i) => map.set(s.id, SERIES_COLOURS[i % SERIES_COLOURS.length]!));
    return map;
  }, [data?.servers]);

  const charted = useMemo(() => (data?.series ?? []).slice(0, MAX_SERIES), [data?.series]);

  const seriesFor = useCallback(
    (pick: (p: { cpu: number; mem: number; players: number | null }) => number | null): ChartSeries[] =>
      charted
        .map((s) => ({
          label: s.label,
          color: colourOf.get(s.id) ?? SERIES_COLOURS[0]!,
          points: s.points
            .map((p) => ({ ts: p.ts, value: pick(p) }))
            .filter((p): p is { ts: number; value: number } => p.value !== null),
        }))
        .filter((s) => s.points.length > 1),
    [charted, colourOf],
  );

  if (!data) return <p className="empty">{error ?? 'Loading…'}</p>;

  const { totals, outcomes } = data;
  const stopped = totals.servers - totals.running;
  const unconfirmed = outcomes.unconfirmed ?? 0;
  const failures = outcomes.failure ?? 0;

  return (
    <>
      <div className="page-head command-head">
        <div>
          <h1>Command centre</h1>
          <p>
            Every server this portal watches. Updated {ago(data.generatedAt)} ago, and again every
            ten seconds.
          </p>
        </div>
        <div className="rangebar">
          <span className="stat-label">Window</span>
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={windowMs === w.ms ? 'btn-ghost small active' : 'btn-ghost small'}
              onClick={() => setWindowMs(w.ms)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="hint bad">{error}</p> : null}

      <section className="statbar">
        <Stat
          value={`${totals.running}/${totals.servers}`}
          label="Servers up"
          sub={stopped === 0 ? 'all running' : `${stopped} stopped`}
          tone={stopped === 0 ? 'ok' : 'warn'}
        />
        <Stat
          value={String(totals.players)}
          label="Players online"
          sub={totals.capacity > 0 ? `of ${totals.capacity} slots` : 'no limit reported'}
        />
        <Stat
          value={String(outcomes.success ?? 0)}
          label="Clean restarts"
          sub="in this window"
          tone="ok"
        />
        <Stat
          value={String(unconfirmed + failures)}
          label="Restarts that did not confirm"
          sub={unconfirmed > 0 ? `${unconfirmed} came back but stayed silent` : 'none'}
          tone={unconfirmed + failures > 0 ? 'bad' : 'plain'}
        />
      </section>

      {data.activeJobs.length > 0 ? (
        <section className="card jobstrip">
          {data.activeJobs.map((job) => (
            <span key={job.serverId} className="pill warn">
              <span className="dot" />
              {job.serverId}: {job.phase} — {job.message}
              {job.actor ? ` (${job.actor})` : ''}
            </span>
          ))}
        </section>
      ) : null}

      <section className="fleet">
        {[...data.servers]
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((server) => (
            <ServerTile
              key={server.id}
              server={server}
              colour={colourOf.get(server.id) ?? SERIES_COLOURS[0]!}
            />
          ))}
      </section>

      <section className="card">
        <TimeChart
          title="Players online"
          series={seriesFor((p) => p.players)}
          format={(v) => String(Math.round(v))}
        />
      </section>

      <div className="chartgrid">
        <section className="card">
          <TimeChart
            title="CPU"
            series={seriesFor((p) => p.cpu)}
            format={(v) => `${v.toFixed(0)}%`}
          />
        </section>
        <section className="card">
          {/* Its own chart, never sharing an axis with CPU: percentages and
              bytes have nothing to do with each other numerically. */}
          <TimeChart title="Memory" series={seriesFor((p) => p.mem)} format={(v) => bytes(v)} />
        </section>
      </div>

      {data.series.length > MAX_SERIES ? (
        <p className="hint">
          Charts show the first {MAX_SERIES} servers; beyond that the lines stop being readable.
          Open a server for its own history.
        </p>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Recent activity</h2>
          <a className="btn-ghost small" {...linkProps('/activity')}>
            Full log
          </a>
        </div>
        {data.recent.length === 0 ? (
          <p className="empty">Nothing yet in this window.</p>
        ) : (
          <ul className="feed">
            {data.recent.map((row) => (
              <li key={row.id}>
                <span className={`feed-result feed-${row.result}`}>{row.result}</span>
                <span className="feed-body">
                  <strong>{row.username}</strong> {row.action}
                  {row.serverId ? ` · ${row.serverId}` : ''}
                  {row.detail ? <em>{row.detail}</em> : null}
                </span>
                <span className="feed-when">{ago(row.ts)} ago</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
