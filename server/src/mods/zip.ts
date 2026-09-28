import { inflateRawSync } from 'node:zlib';

/**
 * A ZIP reader that decides whether an archive is safe *before* extracting
 * anything from it.
 *
 * Mods arrive as ZIPs from the internet and are unpacked into a directory the
 * game server runs from, which is exactly the shape of every zip-slip
 * vulnerability ever written. The order here is deliberate: the central
 * directory is parsed, every entry is judged, and only an archive that passes
 * in full is decompressed. A refusal names the entry that caused it, because
 * "unsafe archive" tells an operator nothing.
 *
 * Written against node:zlib rather than a dependency: the format is small, and
 * a parser this code fully controls is easier to reason about than one whose
 * traversal rules must be taken on trust.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

/** S_IFMT masks from the Unix mode kept in a ZIP's external attributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  /** Unix mode, when the archive was made on a Unix host. */
  mode: number | null;
  isDirectory: boolean;
  localHeaderOffset: number;
  crc32: number;
}

export interface ArchiveLimits {
  /** Everything unpacked, added up. */
  maxTotalBytes: number;
  /** One entry, unpacked. */
  maxEntryBytes: number;
  maxEntries: number;
  /**
   * Largest tolerated unpacked:packed ratio for a single entry. A zip bomb is
   * simply a very good ratio, so this is the one number standing between a
   * 40 KB download and a full array.
   */
  maxRatio: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  // Everything unpacked is held in memory during the write, so this is a
  // ceiling on the portal's own RAM, not on the mod's ambition.
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxRatio: 200,
};

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly entry?: string,
  ) {
    super(message);
  }
}

/** Finds the end-of-central-directory record, which may carry a comment. */
function findEocd(buf: Buffer): number {
  // The comment is at most 65535 bytes, so the record cannot be further back.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ArchiveError('This file is not a ZIP archive.', 'not-a-zip');
}

export function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const directoryOffset = buf.readUInt32LE(eocd + 16);

  if (directoryOffset === ZIP64_MARKER || total === 0xffff) {
    // Rejected rather than half-parsed: a misread offset would be worse than
    // a clear refusal, and no game mod legitimately needs ZIP64.
    throw new ArchiveError('ZIP64 archives are not supported.', 'zip64');
  }
  if (directoryOffset >= buf.length) {
    throw new ArchiveError('The archive is truncated or corrupt.', 'corrupt');
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;

  for (let i = 0; i < total; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ArchiveError('The archive directory is corrupt.', 'corrupt');
    }

    const madeBy = buf.readUInt16LE(at + 4);
    const method = buf.readUInt16LE(at + 10);
    const crc32 = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const uncompressedSize = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const externalAttributes = buf.readUInt32LE(at + 38);
    const localHeaderOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);

    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new ArchiveError('ZIP64 entries are not supported.', 'zip64', name);
    }

    // The upper 16 bits hold the Unix mode, but only when a Unix host wrote
    // the archive (host id 3). Anything else has no mode to speak of.
    const mode = (madeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : null;

    entries.push({
      name,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      mode,
      isDirectory: name.endsWith('/') || (mode !== null && (mode & S_IFMT) === S_IFDIR),
      localHeaderOffset,
    });

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Judges an entry's path. Everything here is a hard refusal: these are not
 * suspicious patterns, they are the ways an archive escapes its directory.
 */
export function checkEntryName(name: string): void {
  if (name.includes('\0')) {
    throw new ArchiveError('An entry name contains a NUL byte.', 'bad-name', name);
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new ArchiveError('An entry uses an absolute path.', 'absolute-path', name);
  }
  // Backslashes are not a ZIP path separator, so a name containing one is
  // either malformed or an attempt to be read differently by Windows.
  if (name.includes('\\')) {
    throw new ArchiveError('An entry name contains a backslash.', 'bad-name', name);
  }
  if (name.split('/').some((segment) => segment === '..')) {
    throw new ArchiveError(
      'An entry would be written outside the mod directory.',
      'path-traversal',
      name,
    );
  }
}

export interface ArchiveReport {
  entries: number;
  files: number;
  totalBytes: number;
  compressedBytes: number;
  /** The worst single-entry compression ratio seen. */
  peakRatio: number;
  extensions: Record<string, number>;
}

/**
 * Walks the whole archive and refuses it on the first genuinely unsafe thing
 * found. Returns a description of what the archive contains, which is what the
 * operator is shown before deciding.
 */
export function analyse(
  entries: ZipEntry[],
  limits: ArchiveLimits = DEFAULT_LIMITS,
): ArchiveReport {
  if (entries.length > limits.maxEntries) {
    throw new ArchiveError(
      `The archive holds ${entries.length} entries, more than the ${limits.maxEntries} allowed.`,
      'too-many-entries',
    );
  }

  const report: ArchiveReport = {
    entries: entries.length,
    files: 0,
    totalBytes: 0,
    compressedBytes: 0,
    peakRatio: 0,
    extensions: {},
  };

  for (const entry of entries) {
    checkEntryName(entry.name);

    if (entry.mode !== null) {
      const kind = entry.mode & S_IFMT;
      if (kind === S_IFLNK) {
        // A symlink is the other way out of the directory: extract one
        // pointing at /etc and the next write follows it.
        throw new ArchiveError('The archive contains a symbolic link.', 'symlink', entry.name);
      }
      if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) {
        throw new ArchiveError(
          'The archive contains something that is neither a file nor a directory.',
          'special-file',
          entry.name,
        );
      }
    }

    if (entry.isDirectory) continue;
    report.files++;

    if (entry.method !== 0 && entry.method !== 8) {
      throw new ArchiveError(
        `Entry uses unsupported compression method ${entry.method}.`,
        'bad-method',
        entry.name,
      );
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new ArchiveError('An entry is larger than the per-file limit.', 'entry-too-large', entry.name);
    }

    // Ratio is only meaningful once an entry is big enough for it to mean
    // anything; a 4-byte file compressing to 1 byte is not an attack.
    if (entry.compressedSize > 1024) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      report.peakRatio = Math.max(report.peakRatio, ratio);
      if (ratio > limits.maxRatio) {
        throw new ArchiveError(
          `An entry expands ${Math.round(ratio)}x, past the ${limits.maxRatio}x limit.`,
          'zip-bomb',
          entry.name,
        );
      }
    }

    report.totalBytes += entry.uncompressedSize;
    report.compressedBytes += entry.compressedSize;
    if (report.totalBytes > limits.maxTotalBytes) {
      throw new ArchiveError('The archive unpacks to more than the total limit.', 'archive-too-large');
    }

    const dot = entry.name.lastIndexOf('.');
    const slash = entry.name.lastIndexOf('/');
    const ext = dot > slash ? entry.name.slice(dot).toLowerCase() : '(none)';
    report.extensions[ext] = (report.extensions[ext] ?? 0) + 1;
  }

  return report;
}

/** Decompresses one entry, verifying it is exactly the size it claimed. */
export function extractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new ArchiveError('An entry has a corrupt local header.', 'corrupt', entry.name);
  }

  const nameLength = buf.readUInt16LE(at + 26);
  const extraLength = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + entry.compressedSize);

  const out = entry.method === 0 ? Buffer.from(body) : inflateRawSync(body);
  if (out.length !== entry.uncompressedSize) {
    // The central directory is what was judged, so anything that unpacks to a
    // different size was not what was approved.
    throw new ArchiveError(
      'An entry unpacked to a different size than it declared.',
      'size-mismatch',
      entry.name,
    );
  }
  return out;
}
