import type { ServerConfig } from './config.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import type { GameQuery } from './query/gamedig.js';
import type { ServerRegistry } from './registry.js';

export interface MetricSample {
  ts: number;
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  players: number | null;
}

const SAMPLE_INTERVAL_MS = 30_000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;

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
 */
export function readStats(raw: DockerStats): Omit<MetricSample, 'ts' | 'players'> {
  const cpuNow = raw.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const cpuBefore = raw.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sysNow = raw.cpu_stats?.system_cpu_usage ?? 0;
  const sysBefore = raw.precpu_stats?.system_cpu_usage ?? 0;

  const cpuDelta = cpuNow - cpuBefore;
  const sysDelta = sysNow - sysBefore;
  const cpuCount = raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;

  const cpuPercent =
    sysDelta > 0 && cpuDelta > 0
      ? Math.min(100 * cpuCount, (cpuDelta / sysDelta) * cpuCount * 100)
      : 0;

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

  function history(serverId: string, sinceMs: number): MetricSample[] {
    return db.readMetrics(serverId, Date.now() - sinceMs);
  }

  return { start, current, history, collect };
}

export type MetricsCollector = ReturnType<typeof createMetricsCollector>;
