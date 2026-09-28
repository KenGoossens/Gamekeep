import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';
import type { DockerClient } from './client.js';

/**
 * Running a command against a container's filesystem, whether or not that
 * container is running.
 *
 * Docker cannot exec into a stopped container, and the operations that need
 * this -- browsing files, installing a mod, removing one -- are precisely the
 * ones only allowed while the server is stopped. A throwaway container
 * borrowing the target's volumes sees the same directories, needs no network,
 * and is removed immediately afterwards.
 */

/**
 * Marks a container as one of ours, so an orphan can be recognised later.
 *
 * Orphans happen: the helper is removed in a finally block, but a finally
 * cannot run if the process is killed first -- a redeploy, a restart, an OOM
 * -- and the container is then left stopped on the host with a random name,
 * looking like something the operator deployed by mistake.
 */
const HELPER_LABEL = 'org.gamekeep.helper';

export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

export function createHelperRunner(dockerClient: DockerClient) {
  const { docker } = dockerClient;

  /**
   * This portal's own image, cached. Borrowed as a shell purely because it is
   * certain to be present: naming any other image would mean a pull, and
   * pulling in order to list a directory would be absurd.
   */
  let selfImage: string | null = null;
  async function ownImage(): Promise<string> {
    if (selfImage) return selfImage;
    try {
      // Docker sets a container's hostname to its id unless told otherwise.
      const info = await docker.getContainer(hostname()).inspect();
      selfImage = info.Image;
      return selfImage;
    } catch (err) {
      throw new HelperError(
        `Could not identify this portal's own container image: ${(err as Error).message}`,
        'no-self-image',
      );
    }
  }

  /** Collects stdout from a multiplexed Docker stream, discarding stderr. */
  async function collect(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<Buffer> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c));

    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
      setTimeout(() => resolve(), timeoutMs).unref();
    });
    return Buffer.concat(chunks);
  }

  /**
   * Runs an argv array -- never a shell string, so a path can never be read as
   * a command -- against the target's volumes in a container of its own.
   */
  async function runDetached(
    container: string,
    cmd: string[],
    timeoutMs = 60_000,
  ): Promise<string> {
    const helper = await docker.createContainer({
      Image: await ownImage(),
      Entrypoint: [],
      Cmd: cmd,
      User: 'root',
      Labels: { [HELPER_LABEL]: '1' },
      HostConfig: {
        VolumesFrom: [container],
        // It touches a filesystem; it has no business reaching anything.
        NetworkMode: 'none',
        AutoRemove: false,
      },
    });

    try {
      const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
      const output = collect(stream, timeoutMs);
      await helper.start();
      const [{ StatusCode }, body] = await Promise.all([helper.wait(), output]);
      if (StatusCode !== 0) {
        throw new HelperError('The command failed.', 'command-failed', StatusCode);
      }
      return body.toString('utf8');
    } finally {
      // Removed whatever happened, so a failure cannot leave litter behind.
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /** Uses exec while the container runs, which is cheaper, and a helper otherwise. */
  async function run(container: string, cmd: string[], timeoutMs = 60_000): Promise<string> {
    const target = docker.getContainer(container);
    const info = await target.inspect();
    if (!info.State?.Running) return runDetached(container, cmd, timeoutMs);

    const exec = await target.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      User: 'root',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const body = await collect(stream, timeoutMs);

    const result = await exec.inspect();
    if (result.ExitCode && result.ExitCode !== 0) {
      throw new HelperError('The command failed.', 'command-failed', result.ExitCode);
    }
    return body.toString('utf8');
  }

  /**
   * Like runDetached, but the helper sees several containers' volumes at once.
   *
   * What backups need: the game's volumes to read from and the portal's own
   * to write into, so tar streams straight from one to the other and no
   * world ever travels through this process. The portal names itself by
   * hostname, which Docker sets to the container id.
   */
  async function runJoined(
    containers: string[],
    cmd: string[],
    timeoutMs = 60_000,
  ): Promise<string> {
    const helper = await docker.createContainer({
      Image: await ownImage(),
      Entrypoint: [],
      Cmd: cmd,
      User: 'root',
      Labels: { [HELPER_LABEL]: '1' },
      HostConfig: {
        VolumesFrom: containers,
        NetworkMode: 'none',
        AutoRemove: false,
      },
    });

    try {
      const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
      const output = collect(stream, timeoutMs);
      await helper.start();
      const [{ StatusCode }, body] = await Promise.all([helper.wait(), output]);
      if (StatusCode !== 0) {
        throw new HelperError('The command failed.', 'command-failed', StatusCode);
      }
      return body.toString('utf8');
    } finally {
      await helper.remove({ force: true }).catch(() => {});
    }
  }

  /**
   * Removes helpers left behind by an earlier life of this process. Run at
   * boot, because that is exactly when the previous one was killed.
   */
  async function sweepOrphans(): Promise<number> {
    let removed = 0;
    try {
      const orphans = await docker.listContainers({
        all: true,
        filters: { label: [`${HELPER_LABEL}=1`] },
      });
      for (const orphan of orphans) {
        await docker.getContainer(orphan.Id).remove({ force: true }).catch(() => {});
        removed++;
      }
    } catch {
      // A sweep that cannot run is not worth failing the boot over.
    }
    return removed;
  }

  return { run, runDetached, runJoined, ownImage, sweepOrphans };
}

export type HelperRunner = ReturnType<typeof createHelperRunner>;
