import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import type { ServerConfig } from '../config.js';
import type { DockerClient } from './client.js';
import type { GameQuery } from '../query/gamedig.js';

export type JobPhase =
  | 'pending'
  | 'pulling'
  | 'stopping'
  | 'starting'
  | 'verifying'
  | 'done'
  | 'failed';

export type Operation = 'restart' | 'start' | 'stop';

export interface Job {
  id: string;
  serverId: string;
  action: 'restart' | 'start' | 'stop' | 'pull-recreate';
  actorUserId: string;
  actorUsername: string;
  /** Captured when the job starts: it settles long after the request is gone. */
  actorIp: string | null;
  actorUserAgent: string | null;
  phase: JobPhase;
  /** Human-readable note for the UI, e.g. "Pulling image (43%)". */
  message: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /**
   * True once the container itself came back, even if the game never answered.
   * Lets a stuck-but-restarted server still start a cooldown, so nobody hammers
   * Restart at a world that is simply slow to load.
   */
  containerRestarted: boolean;
}

export type StartOutcome = { ok: true; job: Job } | { ok: false; reason: 'busy'; job: Job };

const JOB_RETENTION_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createActionRunner(dockerClient: DockerClient, gameQuery: GameQuery) {
  const { docker } = dockerClient;
  /** One active job per server: two friends pressing at once get one restart. */
  const active = new Map<string, Job>();
  /** Finished jobs linger so the UI can read the final phase after completion. */
  const finished = new Map<string, Job>();
  /** Set by the route layer so a settled job can be written to the audit log. */
  let onSettled: ((job: Job) => void) | undefined;

  function getJob(jobId: unknown): Job | undefined {
    if (typeof jobId !== 'string') return undefined;
    for (const job of active.values()) if (job.id === jobId) return job;
    return finished.get(jobId);
  }

  function activeJobFor(serverId: string): Job | undefined {
    return active.get(serverId);
  }

  function retire(job: Job) {
    active.delete(job.serverId);
    finished.set(job.id, job);
    setTimeout(() => finished.delete(job.id), JOB_RETENTION_MS).unref();
  }

  async function pullImage(image: string, job: Job): Promise<void> {
    job.phase = 'pulling';
    job.message = `Pulling ${image}`;
    const stream = (await docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (event.status) {
            job.message = event.progress ? `${event.status} ${event.progress}` : event.status;
          }
        },
      );
    });
  }

  /**
   * Rebuilds create options from a container's own inspect output so the
   * recreated container keeps its volumes, ports, env, networks and restart
   * policy. The deleted fields are the ones Docker generates per-container and
   * either rejects or mangles on the way back in.
   */
  function recreateSpec(info: Dockerode.ContainerInspectInfo): Dockerode.ContainerCreateOptions {
    const config = { ...info.Config } as Record<string, unknown>;
    const shortId = info.Id.slice(0, 12);

    // Docker defaults Hostname to the container's own short id; carrying that
    // over would pin the new container to the old one's identity.
    if (config.Hostname === shortId) delete config.Hostname;

    const networks: Record<string, unknown> = {};
    for (const [name, endpoint] of Object.entries(info.NetworkSettings?.Networks ?? {})) {
      const ep = { ...(endpoint as Record<string, unknown>) };
      // Aliases carry the old short id on user-defined networks, which Docker
      // then rejects as a duplicate.
      if (Array.isArray(ep.Aliases)) {
        const aliases = (ep.Aliases as string[]).filter((a) => a !== shortId);
        if (aliases.length > 0) ep.Aliases = aliases;
        else delete ep.Aliases;
      }
      // Runtime-assigned values must not be replayed into a create call.
      for (const key of [
        'IPAddress',
        'IPPrefixLen',
        'Gateway',
        'IPv6Gateway',
        'GlobalIPv6Address',
        'GlobalIPv6PrefixLen',
        'MacAddress',
        'EndpointID',
        'NetworkID',
        'DriverOpts',
      ]) {
        delete ep[key];
      }
      networks[name] = ep;
    }

    return {
      ...(config as Dockerode.ContainerCreateOptions),
      name: info.Name.replace(/^\//, ''),
      HostConfig: info.HostConfig,
      NetworkingConfig: { EndpointsConfig: networks as never },
    };
  }

  /** Stage 1: the container process is back up. */
  async function verifyContainer(server: ServerConfig, job: Job, deadline: number): Promise<void> {
    job.message = 'Waiting for the container to come back';

    while (Date.now() < deadline) {
      dockerClient.invalidate(server);
      const status = await dockerClient.getStatus(server);
      if (status.running && (status.health === 'none' || status.health === 'healthy')) return;
      if (status.state === 'exited' || status.state === 'dead') {
        throw new Error(
          `The container stopped again immediately (exit code ${status.exitCode ?? 'unknown'}). Check its log in Unraid.`,
        );
      }
      if (status.health === 'unhealthy') {
        throw new Error('The container started but its healthcheck is failing.');
      }
      // Clamped: a slow query can overrun the deadline, and a countdown that
      // reads "-2s left" just looks broken.
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      job.message = `Waiting for the container to come back (${remaining}s left)`;
      await sleep(2000);
    }
    throw new Error(
      `The container did not come back within ${server.restartTimeoutSeconds}s. Check its log in Unraid.`,
    );
  }

  /**
   * Stage 2: the game itself answers a query.
   *
   * A running container is not a running game. A crashed game server can sit
   * inside a perfectly healthy container indefinitely, and reporting that as
   * success is exactly how friends get told the server is back when it is not.
   * Skipped for servers with no query block configured.
   */
  async function verifyGameResponding(
    server: ServerConfig,
    job: Job,
    deadline: number,
  ): Promise<void> {
    const query = server.query;
    if (!query) return;

    job.message = 'Container is up, waiting for the game to respond';

    while (Date.now() < deadline) {
      // The container can still die during this window: a game that crashes a
      // few seconds after start is the main case this stage exists to catch.
      dockerClient.invalidate(server);
      const status = await dockerClient.getStatus(server);
      if (!status.running) {
        throw new Error(
          `The container started but then stopped again (exit code ${status.exitCode ?? 'unknown'}). Check its log in Unraid.`,
        );
      }

      // Bypass the cache: we need a fresh answer, not a five-second-old failure.
      gameQuery.invalidate(server.id);
      if (await gameQuery.getPlayers(server)) return;

      // Clamped: a slow query can overrun the deadline, and a countdown that
      // reads "-2s left" just looks broken.
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      job.message = `Container is up, waiting for the game to respond (${remaining}s left)`;
      await sleep(2000);
    }

    throw new Error(
      `The container is running, but the game is not answering on ${query.host}:${query.port} after ` +
        `${server.restartTimeoutSeconds}s. A large world can take longer than that to load, so it may ` +
        `still be coming up. Check again shortly, or raise restartTimeoutSeconds for this server.`,
    );
  }

  async function verify(server: ServerConfig, job: Job): Promise<void> {
    job.phase = 'verifying';
    const deadline = Date.now() + server.restartTimeoutSeconds * 1000;

    await verifyContainer(server, job, deadline);
    // From here the restart itself has worked, whatever the game does next.
    job.containerRestarted = true;
    await verifyGameResponding(server, job, deadline);
  }

  async function runRestart(server: ServerConfig, job: Job): Promise<void> {
    job.phase = 'stopping';
    job.message = 'Restarting the container';
    await docker.getContainer(server.container).restart({ t: 15 });
    await verify(server, job);
  }

  async function runStart(server: ServerConfig, job: Job): Promise<void> {
    job.phase = 'starting';
    job.message = 'Starting the container';
    try {
      await docker.getContainer(server.container).start();
    } catch (err) {
      // 304 means it was already running, which is not a failure.
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
    await verify(server, job);
  }

  /**
   * Stopping is verified against Docker only -- there is no game left to ask.
   */
  async function runStop(server: ServerConfig, job: Job): Promise<void> {
    job.phase = 'stopping';
    job.message = 'Stopping the container';
    try {
      await docker.getContainer(server.container).stop({ t: 30 });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }

    job.phase = 'verifying';
    job.message = 'Waiting for it to stop';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      dockerClient.invalidate(server);
      const status = await dockerClient.getStatus(server);
      if (!status.running) {
        gameQuery.invalidate(server.id);
        return;
      }
      await sleep(1500);
    }
    throw new Error('The container did not stop within 60s.');
  }

  /**
   * Pull first, and only then stop and replace. A failed pull must leave the
   * running server untouched. This is the one genuinely destructive path in the
   * app, so the create options are captured before anything is removed and the
   * window in which no container exists is kept as small as possible.
   */
  async function runPullRecreate(server: ServerConfig, job: Job): Promise<void> {
    const container = docker.getContainer(server.container);
    const info = await container.inspect();
    const image = info.Config.Image;
    if (!image) throw new Error('Could not determine the container image.');

    await pullImage(image, job);
    const spec = recreateSpec(info);

    job.phase = 'stopping';
    job.message = 'Stopping the old container';
    try {
      await container.stop({ t: 15 });
    } catch (err) {
      // 304 means it was already stopped, which is fine.
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
    // Named and bind volumes survive; v:false only drops anonymous volumes'
    // references, and the game data lives on bind mounts from /mnt/user.
    await container.remove({ v: false });

    job.phase = 'starting';
    job.message = 'Creating the updated container';
    const created = await docker.createContainer(spec);
    await created.start();

    await verify(server, job);
  }

  function start(
    server: ServerConfig,
    actor: { userId: string; username: string; ip?: string; userAgent?: string | null },
    operation: Operation = 'restart',
  ): StartOutcome {
    const existing = active.get(server.id);
    if (existing) return { ok: false, reason: 'busy', job: existing };

    const job: Job = {
      id: randomUUID(),
      serverId: server.id,
      action: operation === 'restart' ? server.updateStrategy : operation,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorIp: actor.ip ?? null,
      actorUserAgent: actor.userAgent ?? null,
      phase: 'pending',
      message: operation === 'stop' ? 'Stopping' : 'Starting',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      containerRestarted: false,
    };
    active.set(server.id, job);

    const work =
      operation === 'stop'
        ? runStop(server, job)
        : operation === 'start'
          ? runStart(server, job)
          : server.updateStrategy === 'pull-recreate'
            ? runPullRecreate(server, job)
            : runRestart(server, job);

    void work
      .then(() => {
        job.phase = 'done';
        job.message = operation === 'stop' ? 'Stopped' : 'Back up';
      })
      .catch((err: unknown) => {
        job.phase = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.message = operation === 'stop' ? 'Stop failed' : 'Start failed';
      })
      .finally(() => {
        job.finishedAt = Date.now();
        dockerClient.invalidate(server);
        retire(job);
        onSettled?.(job);
      });

    return { ok: true, job };
  }

  function setOnSettled(fn: (job: Job) => void) {
    onSettled = fn;
  }

  return { start, getJob, activeJobFor, setOnSettled };
}

export type ActionRunner = ReturnType<typeof createActionRunner>;
