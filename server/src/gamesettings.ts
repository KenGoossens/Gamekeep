import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import { createHelperRunner } from './docker/helper.js';
import { createFileBrowser, dataRootsOf } from './files.js';
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

export type JoinKey = (typeof JOIN_KEYS)[number];

export interface GameSettingsView {
  /** The config file, as an absolute container path. */
  file: string;
  gameLabel: string;
  /** True when editing this file is lost work: the image rewrites it from env. */
  envAuthoritative: boolean;
  /** The join keys this game's file carries, with their current values. */
  values: Array<{ key: JoinKey; fileKey: string; value: string | null }>;
}

/** The four join-setting classes, in one place: routes and type derive from it. */
export const JOIN_KEYS = ['name', 'world', 'password', 'admin'] as const;

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
  // A FUNCTION replacement, never a string: in a string, $& and friends are
  // replacement patterns, so a password like pa$$word would be mangled and
  // a value of $' would splice the rest of the file into the attribute.
  return text.replace(pattern, (_match, open: string, close: string) => open + encodeXml(value) + close);
}

const encodeXml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeXml = (v: string): string =>
  v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * JSON configs (Factorio, V Rising): parsed and rewritten whole, top-level
 * keys only. These files are machine-written, so round-tripping the object is
 * honest — unlike an INI, there are no hand comments to preserve. Only string
 * values are edited: a join setting is text, and silently retyping someone's
 * number or object would be a different kind of damage.
 */
function readJsonKey(text: string, key: string): string | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const value = data?.[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function writeJsonKey(text: string, key: string, value: string): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GameSettingsError('The file is not valid JSON; fix it on the Files tab first.', 'bad-value');
  }
  if (!(key in data)) {
    throw new GameSettingsError(`The file has no "${key}" field to change.`, 'not-found');
  }
  data[key] = value;
  return JSON.stringify(data, null, 2) + '\n';
}

export function createGameSettings(dockerClient: DockerClient) {
  const helpers = createHelperRunner(dockerClient);
  const files = createFileBrowser(dockerClient);
  /**
   * Where each server's config file was last found. The find walks the
   * container's data roots, which is not worth repeating on every Settings
   * tab open — the backup browser learned the same lesson. A cached path
   * that stopped existing is dropped and searched for again.
   */
  const located = new Map<string, string>();

  function profileFor(server: ServerConfig): { label: string; config: GameConfigFile } | null {
    const game = gameByQueryType(server.query?.type);
    if (!game?.configFile) return null;
    return { label: game.label, config: game.configFile };
  }

  /**
   * The find, scoped: the server's own mounted data roots, one filesystem
   * each — never /, never /proc, never a host bind the game was given.
   */
  async function findInRoots(server: ServerConfig, args: string[]): Promise<string[]> {
    let roots: string[];
    try {
      roots = await dataRootsOf(dockerClient, server);
    } catch {
      return [];
    }
    const hits: string[] = [];
    for (const root of roots) {
      try {
        const output = await helpers.run(
          server.container,
          ['find', root, '-xdev', '-maxdepth', '9', ...args, '-print'],
          45_000,
        );
        hits.push(...output.split('\n').map((l) => l.trim()).filter(Boolean));
      } catch {
        // One root failing must not blank the others' results.
      }
    }
    return hits;
  }

  /** Finds the config file inside the container; null when it does not exist yet. */
  async function locate(server: ServerConfig, config: GameConfigFile): Promise<string | null> {
    // The cache answers first — verified cheaply by reading the file later;
    // a vanished path throws there, clearing the entry for the next call.
    const cached = located.get(server.id);
    if (cached) return cached;

    let found: string | null = null;
    if ('fileName' in config.locate) {
      const hits = (await findInRoots(server, ['-type', 'f', '-name', config.locate.fileName]))
        // Steam keeps pristine copies under its own bookkeeping trees, and
        // Unity games ship their factory defaults under StreamingAssets
        // (V Rising keeps a second ServerHostSettings.json there); the live
        // file is the one the game actually reads.
        .filter((p) => !p.includes('/steamapps/') && !p.includes('/StreamingAssets/'))
        .sort((a, b) => a.length - b.length);
      found = hits[0] ?? null;
    } else {
      const { directory, file } = config.locate;
      for (const dir of await findInRoots(server, ['-type', 'd', '-path', `*/${directory}`])) {
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
        if (name) {
          found = `${dir}/${name}`;
          break;
        }
      }
    }

    if (found) located.set(server.id, found);
    return found;
  }

  /** Reads the located file; a vanished cache entry is cleared and retried once. */
  async function readLocated(server: ServerConfig, config: GameConfigFile): Promise<{ file: string; text: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await locate(server, config);
      if (!file) return null;
      try {
        return { file, text: await files.read(server, file) };
      } catch (err) {
        if (located.delete(server.id) && attempt === 0) continue;
        throw new GameSettingsError(
          `Could not read ${file}: ${(err as Error).message}`,
          'io',
        );
      }
    }
    return null;
  }

  const specOf = (raw: string | { key: string; section: string }) =>
    typeof raw === 'string' ? { key: raw, section: undefined } : { key: raw.key, section: raw.section };

  function readValue(
    text: string,
    config: GameConfigFile,
    raw: string | { key: string; section: string },
  ): string | null {
    const { key, section } = specOf(raw);
    if (config.format === 'xml-properties') return readXmlProp(text, key);
    if (config.format === 'json') return readJsonKey(text, key);
    return ini.readKey(text, key, section);
  }

  /** Null when this game has no described config file or none exists yet. */
  async function scan(server: ServerConfig): Promise<GameSettingsView | null> {
    const profile = profileFor(server);
    if (!profile) return null;
    const read = await readLocated(server, profile.config);
    if (!read) return null;

    const values = (
      Object.entries(profile.config.keys) as Array<[JoinKey, string | { key: string; section: string }]>
    ).map(([key, raw]) => ({
      key,
      fileKey: specOf(raw).key,
      value: readValue(read.text, profile.config, raw),
    }));
    return {
      file: read.file,
      gameLabel: profile.label,
      envAuthoritative: profile.config.envAuthoritative === true,
      values,
    };
  }

  /**
   * Everything that can refuse, done BEFORE anyone stops a server: find the
   * file, read it, apply every edit in memory. All the not-found/bad-value
   * throws happen here, so the caller only stops a server for a write that
   * is certain to succeed. Nothing on disk has changed yet.
   */
  async function prepare(
    server: ServerConfig,
    changes: Partial<Record<JoinKey, string>>,
  ): Promise<{ file: string; text: string; applied: JoinKey[] }> {
    const profile = profileFor(server);
    if (!profile) {
      throw new GameSettingsError('This game has no described configuration file.', 'unsupported');
    }
    const read = await readLocated(server, profile.config);
    if (!read) {
      throw new GameSettingsError(
        'No configuration file yet — the game writes one on its first boot.',
        'not-found',
      );
    }

    let text = read.text;
    const applied: JoinKey[] = [];
    for (const [key, raw] of Object.entries(changes) as Array<[JoinKey, string]>) {
      const keySpec = profile.config.keys[key];
      if (!keySpec) continue;
      const { key: fileKey, section } = specOf(keySpec);
      const value = String(raw).replace(/[\r\n\0]/g, ' ').trim();
      text =
        profile.config.format === 'xml-properties'
          ? writeXmlProp(text, fileKey, value)
          : profile.config.format === 'json'
            ? writeJsonKey(text, fileKey, value)
            : ini.writeKey(text, fileKey, section, value);
      applied.push(key);
    }
    return { file: read.file, text, applied };
  }

  /** The write itself; the file browser's backup covers the regret case. */
  async function commit(server: ServerConfig, file: string, text: string): Promise<void> {
    await files.write(server, file, text);
  }

  return { scan, prepare, commit };
}

export type GameSettings = ReturnType<typeof createGameSettings>;

/** Exported for tests: the file surgery is the part worth pinning down. */
export const __internals = { readXmlProp, writeXmlProp, readJsonKey, writeJsonKey };
