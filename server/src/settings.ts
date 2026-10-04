import type Dockerode from 'dockerode';
import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import type { SettingSpec } from './games.js';

/** A value that does not fit its spec; reported as the operator's to fix. */
export class SettingsError extends Error {}

/** The spellings games use for yes and no, matched as pairs. */
const BOOL_WORDS = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);

/**
 * Holds a changed value to its spec before anything is recreated.
 *
 * Refused loudly rather than passed through: the game would either ignore a
 * bad value or fail to boot on it, and both of those surface minutes later
 * with the server already down. A message now beats a mystery then.
 *
 * Exported for the deploy preflight, which holds the same values to the same
 * specs before the container exists at all.
 */
export function checkAgainstSpec(spec: SettingSpec, value: string): void {
  const trimmed = value.trim();
  switch (spec.type) {
    case 'text': {
      // For text, min/max bound the LENGTH -- how a game says "a password of
      // at least five characters" (Valheim) without a second spec vocabulary.
      if (spec.min !== undefined && trimmed.length > 0 && trimmed.length < spec.min) {
        throw new SettingsError(`${spec.label} must be at least ${spec.min} characters.`);
      }
      if (spec.max !== undefined && trimmed.length > spec.max) {
        throw new SettingsError(`${spec.label} must be at most ${spec.max} characters.`);
      }
      return;
    }
    case 'number': {
      if (!/^-?\d+$/.test(trimmed)) {
        throw new SettingsError(`${spec.label} must be a whole number, not "${value}".`);
      }
      const n = Number(trimmed);
      if (spec.min !== undefined && n < spec.min) {
        throw new SettingsError(`${spec.label} must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new SettingsError(`${spec.label} must be at most ${spec.max}.`);
      }
      return;
    }
    case 'boolean': {
      if (!BOOL_WORDS.has(trimmed.toLowerCase())) {
        throw new SettingsError(
          `${spec.label} is a yes/no setting; "${value}" is neither.`,
        );
      }
      return;
    }
    case 'select': {
      if (!(spec.options ?? []).includes(trimmed)) {
        throw new SettingsError(
          `${spec.label} must be one of: ${(spec.options ?? []).join(', ')}.`,
        );
      }
      return;
    }
    default:
      return;
  }
}

export interface SettingField {
  key: string;
  value: string;
  masked: boolean;
  editable: boolean;
}

/**
 * Variables the container runtime or Unraid sets for itself. Showing them
 * invites people to change things that will simply be overwritten, or worse,
 * break the image's own bootstrap.
 */
const READ_ONLY_KEYS = new Set([
  'PATH', 'HOME', 'TERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'DEBIAN_FRONTEND',
  'HOST_OS', 'HOST_HOSTNAME', 'HOST_CONTAINERNAME', 'DATA_DIR', 'STEAMCMD_DIR',
  'SERVER_DIR', 'GAME_ID', 'UID', 'GID', 'PUID', 'PGID', 'UMASK',
]);

/** Anything that looks like a credential is never echoed back to the browser. */
const SECRET_HINTS = ['PASSWRD', 'PASSWORD', 'PASSWD', 'TOKEN', 'SECRET', 'KEY', 'RCON', 'PWD'];

const looksSecret = (key: string): boolean =>
  SECRET_HINTS.some((hint) => key.toUpperCase().includes(hint));

export function createSettingsManager(dockerClient: DockerClient) {
  const { docker } = dockerClient;

  async function read(server: ServerConfig): Promise<SettingField[]> {
    const info = await docker.getContainer(server.container).inspect();

    return (info.Config?.Env ?? [])
      .map((entry) => {
        const index = entry.indexOf('=');
        return { key: entry.slice(0, index), value: entry.slice(index + 1) };
      })
      .filter((f) => f.key && !READ_ONLY_KEYS.has(f.key))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((f) => ({
        key: f.key,
        // A secret is reported as set or unset, never returned.
        value: looksSecret(f.key) ? (f.value ? '••••••••' : '') : f.value,
        masked: looksSecret(f.key),
        editable: true,
      }));
  }

  /**
   * Applies changed variables by recreating the container.
   *
   * Environment variables are fixed when a container is created, so there is
   * no way to change one without replacing the container -- the same lesson
   * that bites anyone who tries `docker restart` after editing an env file.
   * Everything else about the container is carried over untouched.
   */
  async function apply(
    server: ServerConfig,
    changes: Record<string, string>,
    onProgress: (message: string) => void,
    specs: SettingSpec[] = [],
  ): Promise<string[]> {
    const specFor = new Map(specs.map((spec) => [spec.key, spec]));
    const container = docker.getContainer(server.container);
    const info = await container.inspect();
    const applied: string[] = [];

    const current = new Map<string, string>();
    for (const entry of info.Config?.Env ?? []) {
      const index = entry.indexOf('=');
      current.set(entry.slice(0, index), entry.slice(index + 1));
    }

    for (const [key, value] of Object.entries(changes)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (READ_ONLY_KEYS.has(key)) continue;
      // The masked placeholder means "unchanged", not "set it to dots".
      if (looksSecret(key) && value === '••••••••') continue;
      if (current.get(key) === value) continue;

      const spec = specFor.get(key);
      if (spec) checkAgainstSpec(spec, String(value));

      current.set(key, String(value).replace(/[\r\n]/g, ' '));
      applied.push(key);
    }

    if (applied.length === 0) return [];

    const config = { ...info.Config } as Record<string, unknown>;
    const shortId = info.Id.slice(0, 12);
    if (config.Hostname === shortId) delete config.Hostname;
    config.Env = [...current].map(([k, v]) => `${k}=${v}`);

    const networks: Record<string, unknown> = {};
    for (const [name, endpoint] of Object.entries(info.NetworkSettings?.Networks ?? {})) {
      const ep = { ...(endpoint as Record<string, unknown>) };
      if (Array.isArray(ep.Aliases)) {
        const aliases = (ep.Aliases as string[]).filter((a) => a !== shortId);
        if (aliases.length > 0) ep.Aliases = aliases;
        else delete ep.Aliases;
      }
      for (const key of ['IPAddress','IPPrefixLen','Gateway','IPv6Gateway','GlobalIPv6Address',
                         'GlobalIPv6PrefixLen','MacAddress','EndpointID','NetworkID','DriverOpts']) {
        delete ep[key];
      }
      networks[name] = ep;
    }

    onProgress('Stopping the server');
    try {
      await container.stop({ t: 20 });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 304) throw err;
    }
    await container.remove({ v: false });

    onProgress('Recreating with the new settings');
    const created = await docker.createContainer({
      ...(config as Dockerode.ContainerCreateOptions),
      name: info.Name.replace(/^\//, ''),
      HostConfig: info.HostConfig,
      NetworkingConfig: { EndpointsConfig: networks as never },
    });

    onProgress('Starting');
    await created.start();
    dockerClient.invalidate(server);
    return applied;
  }

  return { read, apply };
}

export type SettingsManager = ReturnType<typeof createSettingsManager>;
