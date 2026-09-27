/**
 * A minimal USTAR writer, which is the format Docker's putArchive expects.
 *
 * Written by hand rather than pulled in: the portal only ever *writes* tars,
 * and the subset needed for that is small enough to read in one sitting. The
 * one subtlety worth knowing is the name split -- USTAR keeps a path in a
 * 100-byte field with a 155-byte prefix, and a mod's paths routinely exceed
 * 100 bytes, so a writer that ignores the prefix silently truncates files into
 * the wrong place.
 */

export interface TarEntry {
  /** Path relative to the directory the archive is unpacked into. */
  name: string;
  content: Buffer;
  mode?: number;
  directory?: boolean;
}

export interface TarOwner {
  uid: number;
  gid: number;
}

export class TarError extends Error {}

/** Splits a path across USTAR's name and prefix fields. */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };

  // The split must fall on a separator, and the prefix is joined back with a
  // '/' on extraction, so the separator itself is dropped.
  for (let at = path.length - 101; at < path.length; at++) {
    const slash = path.indexOf('/', at);
    if (slash === -1) break;

    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new TarError(`Path is too long for a tar archive: ${path}`);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(
  entry: Required<Pick<TarEntry, 'name' | 'mode' | 'directory'>>,
  size: number,
  owner: TarOwner,
): Buffer {
  const block = Buffer.alloc(512);
  const { name, prefix } = splitName(entry.name);

  block.write(name, 0, 'utf8');
  block.write(octal(entry.mode, 8), 100, 'ascii');
  block.write(octal(owner.uid, 8), 108, 'ascii');
  block.write(octal(owner.gid, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136, 'ascii');
  block.write('        ', 148, 'ascii'); // checksum, blank while it is computed
  block.write(entry.directory ? '5' : '0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  if (prefix) block.write(prefix, 345, 'utf8');

  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return block;
}

function pad(length: number): Buffer {
  return Buffer.alloc((512 - (length % 512)) % 512);
}

/** Builds a tar holding any number of files and directories. */
export function buildTarEntries(entries: TarEntry[], owner: TarOwner = { uid: 0, gid: 0 }): Buffer {
  const parts: Buffer[] = [];

  for (const entry of entries) {
    const directory = Boolean(entry.directory);
    const content = directory ? Buffer.alloc(0) : entry.content;
    parts.push(
      header(
        {
          // A directory entry must end in '/' or some extractors treat it as a file.
          name: directory && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name,
          mode: entry.mode ?? (directory ? 0o755 : 0o644),
          directory,
        },
        content.length,
        owner,
      ),
    );
    if (content.length > 0) {
      parts.push(content, pad(content.length));
    }
  }

  // Two zero blocks terminate the archive.
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Builds a one-file tar, the common case. */
export function buildTar(name: string, content: Buffer, mode = 0o644): Buffer {
  return buildTarEntries([{ name, content, mode }]);
}
