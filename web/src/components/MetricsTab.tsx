import { useEffect, useState } from 'react';
import { api, type MetricPoint } from '../api.ts';
import { TimeChart } from './TimeChart.tsx';

// Validated against the portal's dark surface: all six checks pass.
const BLUE = '#3987e5';
const ORANGE = '#d95926';

const bytes = (n: number): string => {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

const RANGES = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  // Only offered because retention genuinely holds a week: a range button
  // that silently shows less than it names is how 7d used to behave.
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

export function MetricsTab({ serverId }: { serverId: string }) {
  const [history, setHistory] = useState<MetricPoint[] | null>(null);
  const [current, setCurrent] = useState<MetricPoint | null>(null);
  const [range, setRange] = useState(RANGES[0]!.ms);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.metrics(serverId, range).then(
        (r) => {
          if (cancelled) return;
          setHistory(r.history);
          setCurrent(r.current);
        },
        () => !cancelled && setHistory([]),
      );
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverId, range]);

  if (history === null) return <p className="empty">Loading…</p>;

  const points = history;
  // Network counters are cumulative, so the rate is the difference between
  // consecutive samples -- the raw totals only ever climb and say nothing.
  const rates = points.slice(1).map((p, i) => {
    const previous = points[i]!;
    const seconds = Math.max(1, (p.ts - previous.ts) / 1000);
    return {
      ts: p.ts,
      rx: Math.max(0, (p.netRx - previous.netRx) / seconds),
      tx: Math.max(0, (p.netTx - previous.netTx) / seconds),
    };
  });

  const memLimit = current?.memLimit || Math.max(...points.map((p) => p.memLimit), 1);

  return (
    <>
      <div className="rangebar">
        <span className="stat-label">Range</span>
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            className={range === r.ms ? 'btn-ghost small active' : 'btn-ghost small'}
            onClick={() => setRange(r.ms)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {current ? (
        <div className="statgrid">
          <div>
            <span className="stat-label">CPU</span>
            <strong>{current.cpuPercent.toFixed(1)}%</strong>
            <span className="hint">
              {/* The per-core truth: a single-threaded game can be CPU-bound
                  at 6% of a sixteen-core machine, and this is what says so. */}
              {current.cpuCores !== null && current.cpuCount
                ? `${current.cpuCores.toFixed(2)} of ${current.cpuCount} cores`
                : ''}
            </span>
          </div>
          <div>
            <span className="stat-label">Memory</span>
            <strong>{bytes(current.memBytes)}</strong>
            <span className="hint">
              {memLimit > 0 ? `${((current.memBytes / memLimit) * 100).toFixed(0)}% of limit` : ''}
            </span>
          </div>
          <div>
            <span className="stat-label">Players</span>
            <strong>{current.players ?? '—'}</strong>
          </div>
        </div>
      ) : (
        <p className="empty">This server is not running, so there is nothing to measure.</p>
      )}

      <TimeChart
        title="CPU"
        max={100}
        format={(v) => `${v.toFixed(0)}%`}
        series={[{ label: 'CPU', color: BLUE, points: points.map((p) => ({ ts: p.ts, value: p.cpuPercent })) }]}
      />

      <TimeChart
        title="Memory"
        max={memLimit > 0 ? memLimit : undefined}
        format={bytes}
        series={[{ label: 'Memory', color: BLUE, points: points.map((p) => ({ ts: p.ts, value: p.memBytes })) }]}
      />

      <TimeChart
        title="Network"
        format={(v) => `${bytes(v)}/s`}
        series={[
          { label: 'In', color: BLUE, points: rates.map((r) => ({ ts: r.ts, value: r.rx })) },
          { label: 'Out', color: ORANGE, points: rates.map((r) => ({ ts: r.ts, value: r.tx })) },
        ]}
      />
    </>
  );
}
