import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import type { GameQuery } from './query/gamedig.js';
import type { ServerRegistry } from './registry.js';

export interface MetricSample {
  ts: number;
  /** Of the whole machine, 0-100. What a person means by "CPU %". */
  cpuPercent: number;
  /**
   * Cores in use, e.g. 1.04. The number that matters for game servers: a
   * single-threaded game pegging one core of sixteen reads 6% machine-wide
   * while being completely CPU-bound — this is the number that says so.
   */
  cpuCores: number | null;
  /** How many cores the machine has, for "1.04 of 16". */
  cpuCount: number | null;
  memBytes: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  players: number | null;
}

const SAMPLE_INTERVAL_MS = 30_000;
/**
 * A week, not a day: "a memory line that climbs for days and drops at each
 * restart" is the pattern this screen exists to show, and a 24-hour window
 * cannot contain it. The cost is ~20k rows per server per day in SQLite,
 * which is nothing; the browser is protected by downsampling below.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** More points than any chart has pixels for. */
const MAX_POINTS = 420;

/**
 * Buckets a long history down to something a chart (and a phone) can carry.
 *
 * Gauges (cpu, memory) average within the bucket; counters (network, disk)
 * take the bucket's last value, so the UI's delta-based rate stays the true
 * average rate across the bucket; players take the max, because "someone was
 * on at 21:00" must survive the squeeze.
 */
export function downsample(points: MetricSample[], maxPoints = MAX_POINTS): MetricSample[] {
  if (points.length <= maxPoints) return points;
  const perBucket = Math.ceil(points.length / maxPoints);
  const out: MetricSample[] = [];
  for (let start = 0; start < points.length; start += perBucket) {
    const bucket = points.slice(start, start + perBucket);
    const last = bucket[bucket.length - 1]!;
    const avg = (pick: (p: MetricSample) => number) =>
      bucket.reduce((sum, p) => sum + pick(p), 0) / bucket.length;
    const playersSeen = bucket.map((p) => p.players).filter((p): p is number => p !== null);
    out.push({
      ...last,
      cpuPercent: Math.round(avg((p) => p.cpuPercent) * 100) / 100,
      cpuCores:
        last.cpuCores === null ? null : Math.round(avg((p) => p.cpuCores ?? 0) * 100) / 100,
      memBytes: Math.round(avg((p) => p.memBytes)),
      players: playersSeen.length > 0 ? Math.max(...playersSeen) : null,
    });
  }
  return out;
}

/** Docker reports counters; these are the deltas we care about. */
interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: Array<{ op?: string; value?: number }> };
}

/**
 * Turns one Docker stats snapshot into the numbers a person wants to see.
 *
 * CPU is a delta between two cumulative counters, so it needs the previous
 * sample Docker ships alongside; when that is missing (the first read after a
 * container starts) the only honest answer is zero rather than a wild number.
 *
 * The percentage is of the WHOLE machine, deliberately not docker-stats'
 * one-core convention: that convention is how a server using slightly more
 * than one core shows "104% CPU" on a sixteen-core box, which reads as
 * nonsense to anyone who has not memorised Docker's definition. The one-core
 * truth still ships, as cores: "6.5% of the machine, 1.04 cores".
 */
export function readStats(raw: DockerStats): Omit<MetricSample, 'ts' | 'players'> {
  const cpuNow = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const cpuBefore = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sysNow = raw.cpu_stats?.system_cpu_usage ?? 0;
  const sysBefore = raw.precpu_stats?.system_cpu_usage ?? 0;

  const cpuDelta = cpuNow - cpuBefore;
  const sysDelta = sysNow - sysBefore;
  const cpuCount = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

  // system_cpu_usage already sums every core, so this fraction is of the
  // machine; clamped because counter jitter can nudge it past 1.
  const machineFraction =
    sysDelta > 0 && cpuDelta > 0 ? Math.min(1, cpuDelta / sysDelta) : 0;
  const cpuPercent = machineFraction * 100;
  const cpuCores = machineFraction * cpuCount;

  // Docker's memory usage includes the page cache, which makes every server
  // look nearly full. Subtracting inactive_file is what `docker stats` does.
  const rawMem = raw.memory_stats?.usage ?? 0;
  const cache = raw.memory_stats?.stats?.inactive_file ?? 0;
  const memBytes = Math.max(0, rawMem - cache);

  let netRx = 0;
  let netTx = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    netRx += iface.rx_bytes ?? 0;
    netTx += iface.tx_bytes ?? 0;
  }

  let blkRead = 0;
  let blkWrite = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = (entry.op ?? '').toLowerCase();
    if (op === 'read') blkRead += entry.value ?? 0;
    if (op === 'write') blkWrite += entry.value ?? 0;
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    cpuCores: Math.round(cpuCores * 100) / 100,
    cpuCount,
    memBytes,
    memLimit: raw.memory_stats?.limit ?? 0,
    netRx,
    netTx,
    blkRead,
    blkWrite,
  };
}

export function createMetricsCollector(
  dockerClient: DockerClient,
  registry: ServerRegistry,
  gameQuery: GameQuery,
  db: Db,
) {
  const { docker } = dockerClient;
  /** Newest sample per server, so the UI has something before the next poll. */
  const latest = new Map<string, MetricSample>();

  async function sample(server: ServerConfig): Promise<MetricSample | null> {
    try {
      const status = await dockerClient.getStatus(server);
      if (!status.running) return null;

      const raw = (await docker
        .getContainer(server.container)
        .stats({ stream: false })) as DockerStats;

      const players = gameQuery.getPlayersCached(server);
      return {
        ts: Date.now(),
        ...readStats(raw),
        players: players ? players.online : null,
      };
    } catch {
      // A container that vanished mid-poll is not an error worth surfacing.
      return null;
    }
  }

  async function collect(): Promise<void> {
    for (const server of registry.list()) {
      const point = await sample(server);
      if (!point) continue;
      latest.set(server.id, point);
      db.recordMetric(server.id, point);
    }
    db.pruneMetrics(Date.now() - RETENTION_MS);
  }

  function start(): NodeJS.Timeout {
    void collect();
    const timer = setInterval(() => void collect(), SAMPLE_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  /** Live reading on demand, for when someone opens the metrics tab. */
  async function current(server: ServerConfig): Promise<MetricSample | null> {
    const point = await sample(server);
    if (point) latest.set(server.id, point);
    return point ?? latest.get(server.id) ?? null;
  }

  /*
   * A 7-day window is ~20k rows per server, and the dashboard polls every
   * ten seconds per viewer. One short-lived cache entry per (server, window)
   * makes the number of viewers irrelevant: everyone shares one read and one
   * downsample per interval.
   */
  const historyCache = new Map<string, { at: number; value: MetricSample[] }>();
  const HISTORY_TTL_MS = 10_000;

  function history(serverId: string, sinceMs: number): MetricSample[] {
    const key = `${serverId}:${sinceMs}`;
    const cached = historyCache.get(key);
    if (cached && Date.now() - cached.at < HISTORY_TTL_MS) return cached.value;
    const value = downsample(db.readMetrics(serverId, Date.now() - sinceMs));
    historyCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Called when a server is deleted, so its entries do not sit around. */
  function forget(serverId: string): void {
    latest.delete(serverId);
    for (const key of historyCache.keys()) {
      if (key.startsWith(`${serverId}:`)) historyCache.delete(key);
    }
  }

  return { start, current, history, collect, forget };
}

export type MetricsCollector = ReturnType<typeof createMetricsCollector>;
