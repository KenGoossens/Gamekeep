import { useMemo, useState } from 'react';

export interface ChartSeries {
  label: string;
  color: string;
  points: Array<{ ts: number; value: number }>;
}

interface Props {
  title: string;
  series: ChartSeries[];
  /** Formats a value for the axis, tooltip and direct label. */
  format: (value: number) => string;
  /** Fixes the top of the scale, e.g. 100 for a percentage. */
  max?: number;
  height?: number;
}

const PAD = { top: 12, right: 54, bottom: 18, left: 8 };

/**
 * One measure per chart, never two y-axes.
 *
 * CPU, memory and network have nothing to do with each other numerically;
 * overlaying them on a shared scale would make the smaller one a flat line and
 * invite comparisons the numbers do not support. Separate charts, each with
 * its own scale, say the true thing.
 */
export function TimeChart({ title, series, format, max, height = 132 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;

  const model = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (all.length < 2) return null;

    const tMin = Math.min(...all.map((p) => p.ts));
    const tMax = Math.max(...all.map((p) => p.ts));
    const vMax = max ?? Math.max(1, ...all.map((p) => p.value)) * 1.15;
    const span = Math.max(1, tMax - tMin);

    const x = (ts: number) => PAD.left + ((ts - tMin) / span) * (width - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - Math.min(1, v / vMax)) * (height - PAD.top - PAD.bottom);

    return { tMin, tMax, vMax, x, y };
  }, [series, max, height]);

  if (!model) {
    return (
      <figure className="chart">
        <figcaption>{title}</figcaption>
        <p className="empty">Not enough data yet — samples are taken every 30 seconds.</p>
      </figure>
    );
  }

  const { x, y, vMax, tMin, tMax } = model;
  const baseline = y(0);

  /** Index of the sample nearest the pointer, shared by every series. */
  const hoverIndex = (clientX: number, rect: DOMRect): number | null => {
    const primary = series[0];
    if (!primary || primary.points.length === 0) return null;
    const ratio = (clientX - rect.left) / rect.width;
    const ts = tMin + ratio * (tMax - tMin);
    let best = 0;
    let bestDelta = Infinity;
    primary.points.forEach((p, i) => {
      const delta = Math.abs(p.ts - ts);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    return best;
  };

  return (
    <figure className="chart">
      <figcaption>
        {title}
        {series.length > 1 ? (
          // A legend is always present from two series up; the direct labels
          // at the line ends carry the same identity without relying on colour.
          <span className="legend">
            {series.map((s) => (
              <span key={s.label}>
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title} over time`}
        onMouseMove={(e) => setHover(hoverIndex(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive grid: three hairlines, well below the data in contrast. */}
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y(vMax * f)}
            y2={y(vMax * f)}
            className="grid"
          />
        ))}
        <text x={width - PAD.right + 6} y={y(vMax) + 4} className="axis">
          {format(vMax)}
        </text>
        <text x={width - PAD.right + 6} y={baseline} className="axis">
          {format(0)}
        </text>

        {series.map((s) => {
          const line = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts)},${y(p.value)}`).join(' ');
          const area = `${line} L${x(s.points[s.points.length - 1]!.ts)},${baseline} L${x(s.points[0]!.ts)},${baseline} Z`;
          return (
            <g key={s.label}>
              <path d={area} fill={s.color} opacity={series.length > 1 ? 0.1 : 0.16} />
              <path d={line} fill="none" stroke={s.color} strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}

        {hover !== null && series[0]?.points[hover] ? (
          <>
            <line
              x1={x(series[0].points[hover]!.ts)}
              x2={x(series[0].points[hover]!.ts)}
              y1={PAD.top}
              y2={baseline}
              className="crosshair"
            />
            {series.map((s) => {
              const point = s.points[hover];
              if (!point) return null;
              return (
                <circle
                  key={s.label}
                  cx={x(point.ts)}
                  cy={y(point.value)}
                  r={4}
                  fill={s.color}
                  // A surface-coloured ring keeps overlapping markers readable.
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              );
            })}
          </>
        ) : null}
      </svg>

      <div className="chart-readout">
        {hover !== null && series[0]?.points[hover] ? (
          <>
            <span className="chart-time">
              {new Date(series[0].points[hover]!.ts).toLocaleTimeString()}
            </span>
            {series.map((s) =>
              s.points[hover] ? (
                <span key={s.label}>
                  <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                  {s.label}: <strong>{format(s.points[hover]!.value)}</strong>
                </span>
              ) : null,
            )}
          </>
        ) : (
          series.map((s) => (
            <span key={s.label}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label} now: <strong>{format(s.points[s.points.length - 1]?.value ?? 0)}</strong>
            </span>
          ))
        )}
      </div>
    </figure>
  );
}
