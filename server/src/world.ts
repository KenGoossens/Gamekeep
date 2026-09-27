import type { ServerConfig } from './config.js';
import type { createFileBrowser } from './files.js';

export interface WorldInfo {
  name: string | null;
  /** The shareable seed string, e.g. "pEESpCbAZk" for Valheim. */
  seed: string | null;
  seedNumber: number | null;
  /** A map viewer for this game and seed, when one exists. */
  mapUrl: string | null;
  source: string;
}

/**
 * Reads the world name and seed from a game's own save metadata.
 *
 * Only games whose format is small, documented and stable enough to parse
 * safely are handled; anything else simply reports nothing rather than
 * guessing. Nothing here writes -- it is read-only by construction.
 */
type Reader = (
  server: ServerConfig,
  files: ReturnType<typeof createFileBrowser>,
) => Promise<WorldInfo | null>;

/** Valheim's .fwl2: a length-prefixed header holding the name and seed. */
function parseValheimHeader(buffer: Buffer): { name: string; seed: string; seedNumber: number } | null {
  let offset = 0;
  const readInt = () => {
    const value = buffer.readInt32LE(offset);
    offset += 4;
    return value;
  };
  // Unity writes strings with a 7-bit-encoded length prefix.
  const readString = () => {
    let length = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = buffer[offset++] ?? 0;
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    const value = buffer.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return value;
  };

  try {
    readInt(); // block size
    readInt(); // format version
    const name = readString();
    const seed = readString();
    const seedNumber = readInt();
    if (!name || !seed) return null;
    return { name, seed, seedNumber };
  } catch {
    return null;
  }
}

const valheim: Reader = async (server, files) => {
  const base = '/serverdata/serverfiles/.config/unity3d/IronGate/Valheim/worlds_local';

  let worldDirectory: string | null = null;
  try {
    const listing = await files.list(server, base);
    // Ignore the automatic backup copies the image makes.
    const world = listing.entries.find(
      (e) => e.kind === 'directory' && !e.name.includes('_backup_auto-'),
    );
    worldDirectory = world?.path ?? null;
  } catch {
    return null;
  }
  if (!worldDirectory) return null;

  try {
    const listing = await files.list(server, worldDirectory);
    const header = listing.entries.find((e) => e.name.endsWith('.fwl2') || e.name.endsWith('.fwl'));
    if (!header) return null;

    const raw = await files.readBinary(server, header.path);
    const parsed = parseValheimHeader(raw);
    if (!parsed) return null;

    return {
      name: parsed.name,
      seed: parsed.seed,
      seedNumber: parsed.seedNumber,
      mapUrl: `https://valheim-map.world/?seed=${encodeURIComponent(parsed.seed)}`,
      source: header.name,
    };
  } catch {
    return null;
  }
};

const READERS: Record<string, Reader> = { valheim };

export async function readWorld(
  server: ServerConfig,
  files: ReturnType<typeof createFileBrowser>,
): Promise<WorldInfo | null> {
  const reader = READERS[server.query?.type ?? ''];
  return reader ? reader(server, files) : null;
}
