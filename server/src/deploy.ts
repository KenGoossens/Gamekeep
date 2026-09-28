import { hostname } from 'node:os';
import { chown, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type Dockerode from 'dockerode';
import type { CatalogApp, ParsedTemplate } from './catalog.js';
import type { DockerClient } from './docker/client.js';

/**
 * Anything the operator adds beyond what the template asked for -- the same
 * three kinds Unraid's own template editor offers.
 *
 * Paths take a container path and a folder name, never a host path. Every
 * mount a deployed server gets still lands inside that server's own
 * directory, which is the guarantee the deploy review leans on: a template
 * cannot ask for /boot or the Docker socket, and neither can a person typing
 * into this form.
 */
export interface ExtraParameters {
  variables: Array<{ name: string; value: string }>;
  ports: Array<{ container: number; host: number; protocol: 'tcp' | 'udp' }>;
  paths: Array<{ container: string; name: string }>;
}

export const NO_EXTRAS: ExtraParameters = { variables: [], ports: [], paths: [] };

/** Env var names as the shell defines them. */
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DeployRequest {
  /** What the server will be called, and the container name. */
  name: string;
  /** Values for the template's Variable fields, keyed by target. */
  variables: Record<string, string>;
  /** Host ports keyed by the template's container port target. */
  ports: Record<string, number>;
  /** Added by the operator on top of the template. */
  extra?: ExtraParameters;
}

export interface DeployPlan {
  containerName: string;
  serverId: string;
  image: string;
  /** Path the portal uses to create the directories. */
  appdataPath: string;
  /** The same directory as the Unraid host sees it; what binds must use. */
  appdataHostPath: string;
  /** Directories to create, in the portal's own view of the filesystem. */
  createPaths: string[];
  network: string;
  env: string[];
  binds: string[];
  portBindings: Record<string, Array<{ HostPort: string }>>;
  exposed: Record<string, Record<string, never>>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

export class DeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

/**
 * Turns a catalogue template into a container we are willing to create.
 *
 * Everything dangerous in an Unraid template is dropped rather than sanitised:
 * host paths from the template are ignored and replaced with a path we choose,
 * ExtraParams (which can contain arbitrary docker flags, --privileged among
 * them) is never applied, and Device mappings are refused outright. What is
 * left is an image, environment variables, published ports and bind mounts
 * inside one directory we control.
 */
export function planDeployment(
  app: CatalogApp,
  template: ParsedTemplate,
  request: DeployRequest,
  appdataRoot: string,
  appdataHostRoot: string,
  /** The network the container joins, whatever the template asked for. */
  gameNetwork: string,
): DeployPlan {
  if (!NAME_PATTERN.test(request.name)) {
    throw new DeployError(
      'Name must be 2-32 characters: letters, digits, and . _ - (starting with a letter or digit).',
      'invalid-name',
    );
  }

  if (template.privileged) {
    throw new DeployError(
      `${app.name} asks to run privileged, which this portal will not deploy.`,
      'privileged-refused',
    );
  }

  /*
   * The template's own choice is checked and then discarded. Refusing host
   * and none still matters -- a template asking for either is telling you
   * something -- but what it actually gets is the portal's game network,
   * because a server on the default bridge cannot be resolved by name and had
   * to be queried through the host's address instead.
   */
  const network = template.network.toLowerCase();
  if (network === 'host' || network === 'none') {
    throw new DeployError(
      `${app.name} wants the "${template.network}" network, which bypasses container isolation.`,
      'network-refused',
    );
  }

  if (template.fields.some((f) => f.type === 'Device')) {
    throw new DeployError(
      `${app.name} wants direct device access, which this portal will not deploy.`,
      'device-refused',
    );
  }

  const serverId = slugify(request.name);
  if (!serverId) throw new DeployError('That name produces an empty id.', 'invalid-name');

  const appdataPath = join(appdataRoot, serverId);
  const appdataHostPath = join(appdataHostRoot, serverId);

  const env: string[] = [];
  const binds: string[] = [];
  const createPaths: string[] = [appdataPath];
  const portBindings: DeployPlan['portBindings'] = {};
  const exposed: DeployPlan['exposed'] = {};

  for (const field of template.fields) {
    if (field.type === 'Variable') {
      if (!field.target) continue;
      const supplied = request.variables[field.target];
      const value = supplied !== undefined ? supplied : field.value;
      if (field.required && !value) {
        throw new DeployError(`"${field.name}" is required.`, 'missing-variable');
      }
      // Newlines would let a value forge additional variables.
      env.push(`${field.target}=${String(value).replace(/[\r\n]/g, ' ')}`);
      continue;
    }

    if (field.type === 'Path') {
      if (!field.target) continue;
      // The template's own host path is deliberately ignored: every mount is
      // placed inside this server's own directory, so a template cannot ask
      // for /mnt/user, /boot or the Docker socket.
      const subdirectory = slugify(field.name) || 'data';
      // The bind uses the host path; the directory is created through ours.
      binds.push(`${join(appdataHostPath, subdirectory)}:${field.target}`);
      createPaths.push(join(appdataPath, subdirectory));
      continue;
    }

    if (field.type === 'Port') {
      const containerPort = Number(field.target.split('-')[0]);
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) continue;

      const protocol = field.mode.toLowerCase() === 'udp' ? 'udp' : 'tcp';
      const key = `${containerPort}/${protocol}`;
      const requested = request.ports[field.target] ?? request.ports[String(containerPort)];
      const hostPort = Number(requested ?? field.value ?? containerPort) || containerPort;

      if (hostPort < 1 || hostPort > 65535) {
        throw new DeployError(`Host port ${hostPort} is out of range.`, 'invalid-port');
      }
      exposed[key] = {};
      portBindings[key] = [{ HostPort: String(hostPort) }];
    }
  }

  /*
   * The operator's own additions, applied after the template so a deliberate
   * value wins over a default. Validated the same way the template's own
   * fields are -- typing something in is not a reason to trust it more.
   */
  const extra = request.extra ?? NO_EXTRAS;

  for (const variable of extra.variables) {
    const name = variable.name.trim();
    if (!name) continue;
    if (!VARIABLE_PATTERN.test(name)) {
      throw new DeployError(
        `"${name}" is not a valid variable name: letters, digits and underscores, not starting with a digit.`,
        'invalid-variable',
      );
    }
    // Same as the template path: a newline would forge a second variable.
    env.push(`${name}=${variable.value.replace(/[\r\n]/g, ' ')}`);
  }

  for (const port of extra.ports) {
    const container = Number(port.container);
    const host = Number(port.host);
    for (const [label, value] of [
      ['container', container],
      ['host', host],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new DeployError(`${value} is not a usable ${label} port.`, 'invalid-port');
      }
    }

    const protocol = port.protocol === 'udp' ? 'udp' : 'tcp';
    const key = `${container}/${protocol}`;
    if (portBindings[key]) {
      throw new DeployError(
        `Port ${container}/${protocol} is already set by the template.`,
        'duplicate-port',
      );
    }
    exposed[key] = {};
    portBindings[key] = [{ HostPort: String(host) }];
  }

  const usedTargets = new Set(binds.map((b) => b.split(':')[1]));
  for (const path of extra.paths) {
    const container = path.container.trim();
    if (!container) continue;
    if (!container.startsWith('/') || container.includes('\0')) {
      throw new DeployError(`"${container}" is not an absolute container path.`, 'invalid-path');
    }
    if (usedTargets.has(container)) {
      throw new DeployError(`${container} is already mounted by the template.`, 'duplicate-path');
    }

    // A folder name, not a host path: this lands inside the server's own
    // directory like every other mount, so nothing here can reach the host.
    const subdirectory = slugify(path.name) || slugify(container) || 'extra';
    usedTargets.add(container);
    binds.push(`${join(appdataHostPath, subdirectory)}:${container}`);
    createPaths.push(join(appdataPath, subdirectory));
  }

  return {
    containerName: request.name,
    serverId,
    image: template.repository,
    appdataPath,
    appdataHostPath,
    createPaths,
    network: gameNetwork,
    env,
    binds,
    portBindings,
    exposed,
  };
}

export function createDeployer(dockerClient: DockerClient) {
  const { docker } = dockerClient;

  /** Host ports already bound by another container, so we can refuse clashes. */
  async function usedHostPorts(): Promise<Set<string>> {
    const containers = await docker.listContainers({ all: true });
    const used = new Set<string>();
    for (const c of containers) {
      for (const p of c.Ports ?? []) {
        if (p.PublicPort) used.add(`${p.PublicPort}/${p.Type ?? 'tcp'}`);
      }
    }
    return used;
  }

  async function containerExists(name: string): Promise<boolean> {
    try {
      await docker.getContainer(name).inspect();
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  async function pull(image: string, onProgress: (message: string) => void): Promise<void> {
    const stream = (await docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (event.status) onProgress(event.progress ? `${event.status} ${event.progress}` : event.status);
        },
      );
    });
  }

  /**
   * Makes sure the game network exists and that the portal is on it.
   *
   * Both steps are done here rather than asked of whoever installs this:
   * a deployed server that the portal cannot resolve by name is the bug this
   * exists to fix, and leaving that to a setup step nobody reads would just
   * move the bug. A running container can join a network without being
   * recreated, so the portal attaches itself.
   */
  async function ensureNetwork(name: string, onProgress: (message: string) => void): Promise<void> {
    const networks = await docker.listNetworks({ filters: { name: [name] } });
    // listNetworks matches on substring, so an exact name still has to be
    // picked out of what comes back.
    if (!networks.some((n) => n.Name === name)) {
      await docker.createNetwork({ Name: name, Driver: 'bridge' });
      onProgress(`Created the ${name} network`);
    }

    const self = docker.getContainer(hostname());
    let attached = false;
    try {
      const info = await self.inspect();
      attached = Object.keys(info.NetworkSettings?.Networks ?? {}).includes(name);
    } catch {
      // Not running in a container we can identify: the connect below will
      // fail too, and its message is the more useful one.
    }

    if (!attached) {
      try {
        await docker.getNetwork(name).connect({ Container: hostname() });
        onProgress(`Joined the ${name} network`);
      } catch (err) {
        throw new DeployError(
          `Could not join the ${name} network, so the new server would be unreachable: ${(err as Error).message}`,
          'network-failed',
        );
      }
    }
  }

  async function create(plan: DeployPlan, onProgress: (message: string) => void): Promise<string> {
    if (await containerExists(plan.containerName)) {
      throw new DeployError(`A container named "${plan.containerName}" already exists.`, 'name-taken');
    }

    const used = await usedHostPorts();
    for (const [key, bindings] of Object.entries(plan.portBindings)) {
      const protocol = key.split('/')[1] ?? 'tcp';
      for (const binding of bindings) {
        if (used.has(`${binding.HostPort}/${protocol}`)) {
          throw new DeployError(
            `Host port ${binding.HostPort}/${protocol} is already in use by another container.`,
            'port-in-use',
          );
        }
      }
    }

    onProgress(`Creating ${plan.appdataHostPath}`);
    for (const path of plan.createPaths) {
      await mkdir(path, { recursive: true });
      // Unraid's appdata convention: nobody:users. Game containers expect to
      // be able to write here, and they do not all chown for themselves.
      await chown(path, 99, 100).catch(() => undefined);
    }

    onProgress(`Pulling ${plan.image}`);
    await pull(plan.image, onProgress);

    onProgress('Creating the container');
    const options: Dockerode.ContainerCreateOptions = {
      name: plan.containerName,
      Image: plan.image,
      Env: plan.env,
      ExposedPorts: plan.exposed,
      Labels: {
        'net.unraid.docker.managed': 'gamekeep',
        'net.unraid.docker.icon': '',
      },
      HostConfig: {
        Binds: plan.binds,
        PortBindings: plan.portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: plan.network,
        // Stated explicitly rather than left to the daemon default, so the
        // intent is visible in the code as well as in the container.
        Privileged: false,
        CapAdd: [],
      },
    };

    const container = await docker.createContainer(options);
    onProgress('Starting');
    await container.start();
    return container.id;
  }

  return { create, ensureNetwork, usedHostPorts, containerExists };
}

export type Deployer = ReturnType<typeof createDeployer>;
