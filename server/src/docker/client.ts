import Docker from 'dockerode';
import type { Env, ServerConfig } from '../config.js';

export type ContainerState =
  | 'running'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'created'
  | 'dead'
  | 'removing'
  | 'missing'
  | 'unknown';

export interface ContainerStatus {
  state: ContainerState;
  running: boolean;
  startedAt: string | null;
  /** Seconds since the container started, or null when it isn't running. */
  uptimeSeconds: number | null;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  exitCode: number | null;
  image: string | null;
  /** Set when Docker itself could not be reached, so the UI can say so. */
  error: string | null;
}

const STATUS_TTL_MS = 2_000;

function dockerOptions(env: Env): Docker.DockerOptions {
  if (env.DOCKER_HOST) {
    const url = new URL(env.DOCKER_HOST);
    return {
      protocol: url.protocol === 'https:' ? 'https' : 'http',
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 2375)),
    };
  }
  return { socketPath: env.DOCKER_SOCKET_PATH };
}

const MISSING: ContainerStatus = {
  state: 'missing',
  running: false,
  startedAt: null,
  uptimeSeconds: null,
  health: 'none',
  exitCode: null,
  image: null,
  error: null,
};

export function createDockerClient(env: Env) {
  const docker = new Docker(dockerOptions(env));
  const cache = new Map<string, { at: number; status: ContainerStatus }>();
  const inFlight = new Map<string, Promise<ContainerStatus>>();

  async function inspect(containerName: string): Promise<ContainerStatus> {
    try {
      const info = await docker.getContainer(containerName).inspect();
      const state = info.State;
      const startedAt = state.StartedAt && !state.StartedAt.startsWith('0001-') ? state.StartedAt : null;
      const startedMs = startedAt ? Date.parse(startedAt) : NaN;

      return {
        state: (state.Status as ContainerState) ?? 'unknown',
        running: Boolean(state.Running),
        startedAt,
        uptimeSeconds:
          state.Running && Number.isFinite(startedMs)
            ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
            : null,
        health: (state.Health?.Status as ContainerStatus['health']) ?? 'none',
        exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
        image: info.Config?.Image ?? null,
        error: null,
      };
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      // A container named in servers.json but absent on the host is a config
      // mistake, not a server error -- surface it in the UI instead of a 500.
      if (statusCode === 404) return { ...MISSING };
      return {
        ...MISSING,
        state: 'unknown',
        error: (err as Error).message || 'Could not reach Docker',
      };
    }
  }

  /**
   * Cached for two seconds and de-duplicated while in flight: a room full of
   * friends polling every five seconds must not turn into a burst of inspect
   * calls against the Docker socket.
   */
  async function getStatus(server: ServerConfig): Promise<ContainerStatus> {
    const key = server.container;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = inspect(key)
      .then((status) => {
        cache.set(key, { at: Date.now(), status });
        return status;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  /** Drops the cache entry so the next poll reflects an action immediately. */
  function invalidate(server: ServerConfig) {
    cache.delete(server.container);
  }

  async function ping(): Promise<boolean> {
    try {
      await docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  return { docker, getStatus, invalidate, ping };
}

export type DockerClient = ReturnType<typeof createDockerClient>;
