import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import { createHelperRunner } from './docker/helper.js';
import { createFileBrowser } from './files.js';
import { gameByQueryType, type GameConfigFile } from './games.js';
import { __internals as ini } from './mods/declare.js';

/**
 * The Settings Scan: where does this server keep its Game Settings — the
 * game's OWN configuration file — and what do its join keys say right now?
 *
 * The file is the better source of truth than environment variables wherever
 * the image lets it be one: server.properties is defined by Minecraft and
 * identical under every image, while env spellings differ per maintainer (the
 * confusion the Valheim SRV_PWD bug grew from). Where the common images
 * regenerate the file from env on every boot, the registry says so and the
 * scan reports it instead of offering an edit that would be silently undone.
 *
 * Found, parsed and written with the same discipline as the Workshop
 * declarations: the file is located rather than assumed, only the asked-for
 * lines change, and the file browser does the write — same backup, same
 * ownership handling as a hand edit.
 */

export class GameSettingsError extends Error {
  constructor(
    message: string,
    public readonly code: 'unsupported' | 'not-found' | 'bad-value' | 'io' = 'io',
  ) {
    super(message);
  }
}

export type JoinKey = 'name' | 'world' | 'password' | 'admin';

export interface GameSettingsView {
  /** The config file, as an absolute container path. */
  file: string;
  gameLabel: string;
  /** True when editing this file is lost work: the image rewrites it from env. */
  envAuthoritative: boolean;
  /** The join keys this game's file carries, with their current values. */
  values: Array<{ key: JoinKey; fileKey: string; value: string | null }>;
}

const LABELS: Record<JoinKey, string> = {
  name: 'Server name',
  world: 'World',
  password: 'Password',
  admin: 'Admin password',
};

export const JOIN_LABELS = LABELS;

/** 7DTD-style <property name="X" value="Y"/> lines, edited line by line. */
function readXmlProp(text: string, key: string): string | null {
  const pattern = new RegExp(`<property\\s+name="${key}"\\s+value="([^"]*)"`, 'i');
  const match = pattern.exec(text);
  return match ? decodeXml(match[1]!) : null;
}

function writeXmlProp(text: string, key: string, value: string): string {
  const pattern = new RegExp(`(<property\\s+name="${key}"\\s+value=")[^"]*(")`, 'i');
  if (!pattern.test(text)) {
    throw new GameSettingsError(
      `The file has no <property name="${key}"> line to change.`,
      'not-found',
    );
  }
  return text.replace(pattern, `$1${encodeXml(value)}$2`);
}

const encodeXml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeXml = (v: string): string =>
  v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function createGameSettings(dockerClient: DockerClient) {
  const helpers = createHelperRunner(dockerClient);
  const files = createFileBrowser(dockerClient);

  function profileFor(server: ServerConfig): { label: string; config: GameConfigFile } | null {
    const game = gameByQueryType(server.query?.type);
    if (!game?.configFile) return null;
    return { label: game.label, config: game.configFile };
  }

  /** Finds the config file inside the container; null when it does not exist yet. */
  async function locate(server: ServerConfig, config: GameConfigFile): Promise<string | null> {
    try {
      if ('fileName' in config.locate) {
        const output = await helpers.run(
          server.container,
          // -maxdepth keeps this off the SteamCMD tree; a game's own config
          // is never buried that deep.
          ['find', '/', '-maxdepth', '9', '-type', 'f', '-name', config.locate.fileName, '-print'],
          60_000,
        );
        const hits = output.split('\n').map((l) => l.trim()).filter(Boolean)
          // Steam keeps pristine copies under its own bookkeeping trees;
          // the live file is the one the game reads.
          .filter((p) => !p.includes('/steamapps/'))
          .sort((a, b) => a.length - b.length);
        return hits[0] ?? null;
      }

      const { directory, file } = config.locate;
      const output = await helpers.run(
        server.container,
        ['find', '/', '-maxdepth', '9', '-type', 'd', '-path', `*/${directory}`, '-print'],
        60_000,
      );
      for (const dir of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
        let listing: string;
        try {
          listing = await helpers.run(server.container, ['ls', '-1', '--', dir], 30_000);
        } catch {
          continue;
        }
        const name = listing
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => file.test(l))
          .sort()[0];
        if (name) return `${dir}/${name}`;
      }
      return null;
    } catch (err) {
      throw new GameSettingsError(
        `Could not search this server for its configuration: ${(err as Error).message}`,
        'io',
      );
    }
  }

  function readValue(text: string, config: GameConfigFile, fileKey: string): string | null {
    return config.format === 'xml-properties'
      ? readXmlProp(text, fileKey)
      : ini.readKey(text, fileKey, undefined);
  }

  /** Null when this game has no described config file or none exists yet. */
  async function scan(server: ServerConfig): Promise<GameSettingsView | null> {
    const profile = profileFor(server);
    if (!profile) return null;
    const file = await locate(server, profile.config);
    if (!file) return null;

    const text = await files.read(server, file);
    const values = (Object.entries(profile.config.keys) as Array<[JoinKey, string]>).map(
      ([key, fileKey]) => ({ key, fileKey, value: readValue(text, profile.config, fileKey) }),
    );
    return {
      file,
      gameLabel: profile.label,
      envAuthoritative: profile.config.envAuthoritative === true,
      values,
    };
  }

  /**
   * Writes the changed join keys into the file — nothing else moves, and the
   * file browser's backup covers the regret case. The caller owns the
   * stop/start choreography and the re-verification; this is only the edit.
   */
  async function apply(
    server: ServerConfig,
    changes: Partial<Record<JoinKey, string>>,
  ): Promise<{ file: string; applied: JoinKey[] }> {
    const profile = profileFor(server);
    if (!profile) {
      throw new GameSettingsError('This game has no described configuration file.', 'unsupported');
    }
    const file = await locate(server, profile.config);
    if (!file) {
      throw new GameSettingsError(
        'No configuration file yet — the game writes one on its first boot.',
        'not-found',
      );
    }

    // Read-modify-write against the file as it is right now, never a stale copy.
    let text = await files.read(server, file);
    const applied: JoinKey[] = [];
    for (const [key, raw] of Object.entries(changes) as Array<[JoinKey, string]>) {
      const fileKey = profile.config.keys[key];
      if (!fileKey) continue;
      const value = String(raw).replace(/[\r\n\0]/g, ' ').trim();
      text =
        profile.config.format === 'xml-properties'
          ? writeXmlProp(text, fileKey, value)
          : ini.writeKey(text, fileKey, undefined, value);
      applied.push(key);
    }
    if (applied.length > 0) await files.write(server, file, text);
    return { file, applied };
  }

  return { scan, apply };
}

export type GameSettings = ReturnType<typeof createGameSettings>;

/** Exported for tests: the file surgery is the part worth pinning down. */
export const __internals = { readXmlProp, writeXmlProp };
