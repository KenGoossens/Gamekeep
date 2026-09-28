/**
 * Declaring Steam Workshop mods in a game server's own configuration.
 *
 * The counterpart to install.ts, for the games that fetch their own mods. No
 * archive is downloaded, unpacked or scanned here: a line in a config file is
 * edited, the server is restarted, and SteamCMD does the rest. That makes this
 * module small, and it makes the two risks different ones -- not "what is in
 * this zip" but "is this the right file, and did we leave it intact".
 *
 * Both are handled by not writing the file blind. The config is located rather
 * than assumed, because its name varies per server and per image; it is parsed
 * and re-emitted line by line, so comments, ordering and every unrelated
 * setting survive; and the existing file browser does the actual write, which
 * means the same backup and the same ownership handling as a hand edit.
 */

import type { ServerConfig } from '../config.js';
import type { DockerClient } from '../docker/client.js';
import { createHelperRunner } from '../docker/helper.js';
import { createFileBrowser } from '../files.js';
import type { WorkshopLayout } from '../games.js';
import { ModSourceError } from './sources.js';

export interface Declaration {
  /** The config file this was read from, as an absolute container path. */
  file: string;
  /** Workshop ids, in the order the file lists them. */
  items: string[];
  /** Publisher mod names, for the games that keep a second list. */
  modIds: string[];
}

/** An id safe to write into a separated list. */
const WORKSHOP_ID = /^\d{1,20}$/;
const MOD_ID = /^[A-Za-z0-9._-]{1,64}$/;

function splitList(value: string, separator: string): string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Reads one key out of an INI, honouring sections when the layout names one.
 *
 * Deliberately not a general INI parser. These files are edited by hand, by
 * the game, and by whatever the container's entrypoint does on boot, so the
 * only safe posture is to touch the one line asked for and leave every other
 * byte exactly as found.
 */
function readKey(text: string, key: string, section: string | undefined): string | null {
  let inSection = section === undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (section !== undefined && trimmed.startsWith('[')) {
      inSection = trimmed.slice(1, -1).trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      return trimmed.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Replaces one key's value, or adds it if the file does not have it yet.
 *
 * Returns the whole file. A key that is missing is appended to its section --
 * or to the end for a flat file -- rather than treated as an error: a server
 * that has never had a mod simply has no such line.
 */
function writeKey(text: string, key: string, section: string | undefined, value: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let inSection = section === undefined;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (section !== undefined && trimmed.startsWith('[')) {
      if (inSection) {
        // Leaving the section we wanted: this is where a new key belongs.
        sectionEnd = i;
        inSection = false;
        break;
      }
      inSection = trimmed.slice(1, -1).trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq >= 0 && trimmed.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      // Indentation is preserved, because some of these files have it.
      const indent = lines[i]!.slice(0, lines[i]!.length - lines[i]!.trimStart().length);
      lines[i] = `${indent}${trimmed.slice(0, eq).trim()}=${value}`;
      return lines.join(newline);
    }
  }

  if (section !== undefined && !inSection && sectionEnd < 0) {
    // The section is not in the file at all; add it and the key together.
    const body = [`[${section}]`, `${key}=${value}`];
    const gap = text.endsWith('\n') || text === '' ? [] : [''];
    return [text, ...gap, ...body, ''].join(newline);
  }

  const at = sectionEnd >= 0 ? sectionEnd : lines.length;
  lines.splice(at, 0, `${key}=${value}`);
  return lines.join(newline);
}

export function createWorkshopDeclarations(dockerClient: DockerClient) {
  const helpers = createHelperRunner(dockerClient);
  const files = createFileBrowser(dockerClient);

  /**
   * Finds the game's config file inside the container.
   *
   * Searched rather than hardcoded: Project Zomboid names the file after the
   * server, and the path above it differs between container images -- one
   * image roots the game at /serverdata/serverfiles and another at /config,
   * and a wrong guess here would silently create a config nobody reads.
   */
  async function locate(server: ServerConfig, layout: WorkshopLayout): Promise<string> {
    let output: string;
    try {
      // -maxdepth keeps this off a SteamCMD tree with tens of thousands of
      // files; the game's own config is never that deep.
      output = await helpers.run(
        server.container,
        ['find', '/', '-maxdepth', '9', '-type', 'd', '-path', `*/${layout.directory}`, '-print'],
        60_000,
      );
    } catch (err) {
      throw new ModSourceError(
        `Could not search this server for its configuration: ${(err as Error).message}`,
        'config-not-found',
      );
    }

    const directories = output.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const directory of directories) {
      let listing: string;
      try {
        listing = await helpers.run(server.container, ['ls', '-1', '--', directory], 30_000);
      } catch {
        continue;
      }
      const name = listing
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => layout.file.test(l))
        .sort()[0];
      if (name) return `${directory}/${name}`;
    }

    throw new ModSourceError(
      `This server has no ${layout.directory} configuration yet. Start it once so it writes one, then come back.`,
      'config-not-found',
    );
  }

  async function read(server: ServerConfig, layout: WorkshopLayout): Promise<Declaration> {
    const file = await locate(server, layout);
    const text = await files.read(server, file);

    const items = splitList(readKey(text, layout.itemsKey, layout.section) ?? '', layout.separator);
    const modIds = layout.modIdsKey
      ? splitList(readKey(text, layout.modIdsKey, layout.section) ?? '', layout.separator)
      : [];

    return { file, items, modIds };
  }

  /**
   * Writes both lists back.
   *
   * Read-modify-write against the file as it is on disk right now, rather than
   * against whatever the browser was last shown: the server's own entrypoint
   * rewrites these files on boot, and saving a stale copy would undo settings
   * nobody touched.
   */
  async function write(
    server: ServerConfig,
    layout: WorkshopLayout,
    next: { items: string[]; modIds: string[] },
  ): Promise<Declaration> {
    for (const id of next.items) {
      if (!WORKSHOP_ID.test(id)) {
        throw new ModSourceError(`${id} is not a Workshop id.`, 'bad-reference');
      }
    }
    for (const id of next.modIds) {
      if (!MOD_ID.test(id)) {
        throw new ModSourceError(`${id} is not a usable mod name.`, 'bad-reference');
      }
    }

    const file = await locate(server, layout);
    const before = await files.read(server, file);

    let text = writeKey(before, layout.itemsKey, layout.section, next.items.join(layout.separator));
    if (layout.modIdsKey) {
      text = writeKey(text, layout.modIdsKey, layout.section, next.modIds.join(layout.separator));
    }

    // The browser makes the backup and preserves ownership, exactly as it does
    // for a hand edit of the same file.
    await files.write(server, file, text);
    return { file, items: [...next.items], modIds: [...next.modIds] };
  }

  return { locate, read, write };
}

export type WorkshopDeclarations = ReturnType<typeof createWorkshopDeclarations>;

/** Exported for tests: the parsing is the part most worth pinning down. */
export const __internals = { readKey, writeKey, splitList };
