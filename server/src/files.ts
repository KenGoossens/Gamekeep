import { Readable } from 'node:stream';
import type { DockerClient } from './docker/client.js';
import type { ServerConfig } from './config.js';
import { buildTar } from './tar.js';
import { PathError, safeSegment } from './paths.js';
import { createHelperRunner } from './docker/helper.js';

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'other';
  size: number;
  editable: boolean;
}

/** Only text formats a person would sensibly hand-edit. */
const EDITABLE_EXTENSIONS = new Set([
  'cfg', 'conf', 'config', 'ini', 'json', 'yaml', 'yml',
  'properties', 'txt', 'log', 'xml', 'toml', 'env', 'sh', 'md',
]);

const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export class FileError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const isEditable = (name: string): boolean => EDITABLE_EXTENSIONS.has(extensionOf(name));

/**
 * Normalises a client-supplied path and confines it to the server's own data
 * directory.
 *
 * Every path the editor touches goes through here. It resolves "." and ".."
 * itself rather than trusting the container, so no combination of segments can
 * climb out of the root -- and the root comes from the server's configuration,
 * never from the request.
 */
export function resolveInside(root: string, requested: string): string {
  const parts = `${root}/${requested}`.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    // A NUL byte would truncate the path inside a C library further down.
    if (part.includes('\0')) throw new FileError('Invalid path.', 'invalid-path');
    stack.push(part);
  }

  const resolved = `/${stack.join('/')}`;
  const rootNormalised = `/${root.split('/').filter((p) => p && p !== '.').join('/')}`;

  if (resolved !== rootNormalised && !resolved.startsWith(`${rootNormalised}/`)) {
    throw new FileError('That path is outside this server’s data directory.', 'outside-root');
  }
  return resolved;
}

/**
 * Every directory the container has mounted, which is exactly the set of
 * places a game server keeps anything worth editing.
 *
 * An earlier version guessed a single "best" mount and got it wrong: for
 * Valheim it chose /serverdata/steamcmd over /serverdata/serverfiles, because
 * "serverdata" contains "data". Listing them all removes the guess.
 */
export async function dataRootsOf(
  dockerClient: DockerClient,
  server: ServerConfig,
): Promise<string[]> {
  const info = await dockerClient.docker.getContainer(server.container).inspect();
  const roots = (info.Mounts ?? [])
    .map((m) => m.Destination)
    .filter((d): d is string => Boolean(d) && d !== '/')
    .sort();

  if (roots.length === 0) {
    throw new FileError('This server has no mounted directories to browse.', 'no-data-dir');
  }
  return roots;
}

/** Confines a path to whichever mount it belongs to, or refuses it. */
export function resolveInsideAny(roots: string[], requested: string): string {
  /*
   * A path that names one of the mounts belongs to that mount and to no other.
   * Without deciding that first, the mounts are simply tried in order and the
   * earliest one swallows the path as if it were relative: asking for
   * /serverdata/steamcmd while /serverdata/serverfiles sorts first quietly
   * yields /serverdata/serverfiles/serverdata/steamcmd, which exists nowhere.
   * The trailing slash matters -- /data must not claim /database.
   */
  const owner = roots.find((r) => requested === r || requested.startsWith(`${r}/`));
  // Traversal out of the owning mount is refused here rather than retried
  // against the others, so ".." can never walk from one mount into another.
  if (owner) return resolveInside(owner, requested.slice(owner.length));

  for (const root of roots) {
    try {
      return resolveInside(root, requested);
    } catch {
      // Try the next mount.
    }
  }
  throw new FileError('That path is outside this server’s data directories.', 'outside-root');
}

export function createFileBrowser(dockerClient: DockerClient) {
  const { docker } = dockerClient;

  const { run } = createHelperRunner(dockerClient);

  /** Parses `ls -lA`, which both busybox and GNU coreutils produce. */
  function parseListing(output: string, dir: string): FileEntry[] {
    const entries: FileEntry[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('total ')) continue;

      const columns = trimmed.split(/\s+/);
      if (columns.length < 9) continue;

      const mode = columns[0] ?? '';
      const size = Number(columns[4] ?? 0) || 0;
      // Everything from column 9 onward is the name, which may contain spaces.
      const name = columns.slice(8).join(' ').split(' -> ')[0] ?? '';
      if (!name || name === '.' || name === '..') continue;

      const kind = mode.startsWith('d') ? 'directory' : mode.startsWith('-') ? 'file' : 'other';
      entries.push({
        name,
        path: `${dir === '/' ? '' : dir}/${name}`,
        kind,
        size,
        editable: kind === 'file' && size <= MAX_EDIT_BYTES && isEditable(name),
      });
      if (entries.length >= MAX_ENTRIES) break;
    }

    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
    );
    return entries;
  }

  async function list(server: ServerConfig, requested: string) {
    const roots = await dataRootsOf(dockerClient, server);

    // An empty path shows the mounts themselves rather than picking one.
    if (!requested || requested === '/') {
      return {
        roots,
        root: '',
        path: '',
        entries: roots.map((r) => ({
          name: r,
          path: r,
          kind: 'directory' as const,
          size: 0,
          editable: false,
        })),
      };
    }

    const dir = resolveInsideAny(roots, requested);
    const output = await run(server.container, ['ls', '-lA', '--', dir]);
    const root = roots.find((r) => dir === r || dir.startsWith(`${r}/`)) ?? '';
    return { roots, root, path: dir, entries: parseListing(output, dir) };
  }

  /**
   * Reads a file through the Docker archive API rather than `cat`, so the
   * content never passes through a shell and the size is known up front.
   */
  async function read(server: ServerConfig, requested: string): Promise<string> {
    const roots = await dataRootsOf(dockerClient, server);
    const path = resolveInsideAny(roots, requested);

    if (!isEditable(path.split('/').pop() ?? '')) {
      throw new FileError('That file type cannot be opened here.', 'not-editable');
    }

    const stream = (await docker
      .getContainer(server.container)
      .getArchive({ path })) as unknown as Readable;

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      // The tar wrapper adds a little; allow for it before refusing.
      if (total > MAX_EDIT_BYTES + 8192) {
        throw new FileError('That file is too large to open here.', 'too-large');
      }
      chunks.push(chunk as Buffer);
    }

    return extractSingleFile(Buffer.concat(chunks));
  }

  /**
   * Writes a file back, keeping a timestamped copy of what was there before.
   *
   * The backup is made inside the container with cp, so it lands next to the
   * original on the same volume -- if an edit breaks a server, the previous
   * version is one file away rather than gone.
   */
  async function write(
    server: ServerConfig,
    requested: string,
    content: string,
  ): Promise<{ path: string; backup: string | null; bytes: number; unchanged: boolean }> {
    const roots = await dataRootsOf(dockerClient, server);
    const path = resolveInsideAny(roots, requested);
    const name = path.split('/').pop() ?? '';

    if (!isEditable(name)) {
      throw new FileError('That file type cannot be edited here.', 'not-editable');
    }
    const buffer = Buffer.from(content, 'utf8');
    if (buffer.length > MAX_EDIT_BYTES) {
      throw new FileError('That content is too large to save.', 'too-large');
    }

    // Opening a file and saving it untouched should leave no trace. Compare
    // first, so backups only pile up when something actually changed.
    let existing: string | null = null;
    try {
      existing = await read(server, requested);
    } catch {
      existing = null;
    }
    if (existing !== null && existing === content) {
      return { path, backup: null, bytes: buffer.length, unchanged: true };
    }

    const directory = path.slice(0, path.lastIndexOf('/')) || '/';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${path}.${stamp}.bak`;

    let madeBackup: string | null = null;
    if (existing !== null) {
      try {
        await run(server.container, ['cp', '--', path, backup]);
        madeBackup = backup;
      } catch {
        // A backup we could not take is not a reason to refuse the save.
      }
    }

    const archive = buildTar(name, buffer);
    await docker.getContainer(server.container).putArchive(Readable.from(archive), {
      path: directory,
    });

    return { path, backup: madeBackup, bytes: buffer.length, unchanged: false };
  }

  /** Raw bytes, for callers that parse a binary header themselves. */
  async function readBinary(server: ServerConfig, requested: string): Promise<Buffer> {
    const roots = await dataRootsOf(dockerClient, server);
    const path = resolveInsideAny(roots, requested);

    const stream = (await docker
      .getContainer(server.container)
      .getArchive({ path })) as unknown as Readable;

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += (chunk as Buffer).length;
      if (total > MAX_EDIT_BYTES + 8192) throw new FileError('That file is too large.', 'too-large');
      chunks.push(chunk as Buffer);
    }
    return extractSingleFileBytes(Buffer.concat(chunks));
  }

  /** Creates a new file, refusing to silently replace an existing one. */
  async function create(server: ServerConfig, requested: string): Promise<{ path: string }> {
    const roots = await dataRootsOf(dockerClient, server);
    const path = resolveInsideAny(roots, requested);
    const name = path.split('/').pop() ?? '';

    if (!isEditable(name)) {
      throw new FileError('Only text files can be created here.', 'not-editable');
    }
    try {
      await read(server, requested);
      throw new FileError('A file with that name already exists.', 'exists');
    } catch (err) {
      if (err instanceof FileError && err.code === 'exists') throw err;
      // Anything else means it does not exist yet, which is what we want.
    }

    const directory = path.slice(0, path.lastIndexOf('/')) || '/';
    await docker.getContainer(server.container).putArchive(Readable.from(buildTar(name, Buffer.alloc(0))), {
      path: directory,
    });
    return { path };
  }

  /**
   * Uploads a file of any type. Unlike the editor this accepts binaries -- a
   * mod, a world save, an archive -- so it is capped by size and still
   * confined to the server's own directories.
   */
  async function upload(
    server: ServerConfig,
    directoryRequested: string,
    filename: string,
    content: Buffer,
  ): Promise<{ path: string; bytes: number; replaced: boolean }> {
    // The basename alone, and refused if that leaves nothing usable -- a
    // filename of ".." names the directory's parent, not a file in it. The
    // check this replaces caught NUL bytes but, through a precedence slip,
    // only in names not starting with a dot, and let ".." through entirely.
    let safeName: string;
    try {
      safeName = safeSegment(filename.split('/').pop() ?? '', 'filename');
    } catch (err) {
      throw new FileError(
        err instanceof PathError ? err.message : 'That filename is not allowed.',
        'invalid-name',
      );
    }
    if (content.length > MAX_UPLOAD_BYTES) {
      throw new FileError('That file is too large to upload.', 'too-large');
    }

    const roots = await dataRootsOf(dockerClient, server);
    const directory = resolveInsideAny(roots, directoryRequested);
    const target = `${directory}/${safeName}`;
    // Confirms the composed path is still inside a mount, in case the name
    // itself tried to climb out.
    resolveInsideAny(roots, target);

    let replaced = false;
    try {
      await run(server.container, ['test', '-e', target]);
      replaced = true;
    } catch {
      replaced = false;
    }

    await docker.getContainer(server.container).putArchive(Readable.from(buildTar(safeName, content)), {
      path: directory,
    });
    return { path: target, bytes: content.length, replaced };
  }

  return { list, read, readBinary, write, create, upload, run };
}

/**
 * Minimal tar reader for the single-file archives Docker returns.
 *
 * The format is simple enough that a parser is smaller than a dependency:
 * 512-byte header, an octal size at offset 124, then the content padded up to
 * the next 512-byte boundary.
 */
function extractSingleFileBytes(archive: Buffer): Buffer {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/ .*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const contentStart = offset + 512;
    if (typeFlag === '0' || typeFlag === ' ') {
      return archive.subarray(contentStart, contentStart + size);
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new FileError('That archive contained no readable file.', 'empty-archive');
}

function extractSingleFile(archive: Buffer): string {
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);

    const contentStart = offset + 512;
    if (typeFlag === '0' || typeFlag === '\0') {
      return archive.subarray(contentStart, contentStart + size).toString('utf8');
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new FileError('That archive contained no readable file.', 'empty-archive');
}

