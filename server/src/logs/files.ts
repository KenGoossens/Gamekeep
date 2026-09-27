import type { DockerClient } from '../docker/client.js';
import { createHelperRunner } from '../docker/helper.js';
import { dataRootsOf, resolveInsideAny } from '../files.js';
import type { ServerConfig } from '../config.js';

/**
 * The game's own log files, as opposed to the container's console.
 *
 * Whether these exist at all depends entirely on the game. Valheim writes
 * everything to stdout, so its container log *is* its game log. Enshrouded,
 * Satisfactory and Minecraft each keep a proper log file somewhere different,
 * and that file is where the interesting detail lives -- the container log
 * often shows only the launcher.
 *
 * Followed by reading from a byte offset rather than with "tail -f". A
 * long-running tail inside a game server is a process that outlives the
 * browser tab that asked for it, and a quiet log gives it no reason to notice
 * it is unwanted. Every command here exits on its own.
 */

export interface Chunk {
  /** The file's size now, which is where the next read starts. */
  size: number;
  text: string;
  /** True when the file shrank, meaning it was rotated or replaced. */
  rotated: boolean;
}

export interface LogFile {
  /** Absolute path inside the container. */
  path: string;
  /** What to show in the picker. */
  label: string;
  sizeBytes: number;
  modifiedAt: number | null;
  /** Ranked down: Steam's client chatter is not what anyone came to read. */
  noise: boolean;
}

/** Deep enough for FactoryGame/Saved/Logs, shallow enough to stay quick. */
const MAX_DEPTH = 5;
const MAX_FILES = 40;
/** Never hand back more than this per poll, however far behind the reader is. */
const MAX_CHUNK = 256 * 1024;

/*
 * Paths that are a game server's own log rather than a library's. Order
 * matters: the first pattern a file matches decides how it sorts, so the
 * game's log comes first and the Steam client's logs go last.
 */
const INTERESTING = [/FactoryGame\.log$/i, /enshrouded_server\.log$/i, /screen\.log$/i, /latest\.log$/i];
/*
 * Steam's own client logs, which every SteamCMD-based image produces and
 * nobody opens on purpose. Matched by name rather than by directory: the
 * Enshrouded image drops them straight into its logs/ folder beside the real
 * one, so a path-based rule promoted them to the top of the list.
 */
const NOISE = [
  /_log\.txt$/i,
  /\/system[a-z]*\.txt$/i,
  /\/Steam\/logs\//i,
  /steamcmd/i,
  /supervisord\.log$/i,
];

/**
 * Reads size and any bytes past an offset in one go.
 *
 * The path and offset are argv arguments, never interpolated into the script
 * text: this runs a shell, and a path is the sort of value that eventually
 * contains something surprising.
 */
const READER = [
  'sh',
  '-c',
  'f="$1"; o="$2"; s=$(wc -c < "$f" 2>/dev/null || echo 0); ' +
    'echo "SIZE $s"; ' +
    'if [ "$s" -gt "$o" ]; then tail -c "+$((o+1))" "$f" | head -c "$3"; fi',
  'sh',
];

export function createLogFileReader(dockerClient: DockerClient) {
  const helpers = createHelperRunner(dockerClient);

  function describe(path: string, size: number, mtime: number | null): LogFile {
    const name = path.split('/').pop() ?? path;
    return {
      path,
      label: name,
      sizeBytes: size,
      modifiedAt: mtime,
      noise: NOISE.some((p) => p.test(path)),
    };
  }

  /** Finds candidate log files under the container's own mounts. */
  async function list(server: ServerConfig): Promise<LogFile[]> {
    const roots = await dataRootsOf(dockerClient, server);

    /*
     * find piped into stat, rather than find -printf.
     *
     * Which find runs depends on whether the server is up: a running
     * container is searched with its own, and a stopped one from the helper.
     * Those are GNU find and busybox find, and only the first has -printf --
     * so a command relying on it silently loses every size the moment a
     * server is stopped, which is most of when anyone looks at this.
     * stat -c exists in both.
     */
    const output = await helpers.run(
      server.container,
      [
        'sh',
        '-c',
        'find "$@" -maxdepth ' +
          MAX_DEPTH +
          ' -type f \\( -name "*.log" -o -name "*_log.txt" \\) -size +0 ' +
          '-exec stat -c "%s\t%Y\t%n" {} + 2>/dev/null',
        'sh',
        ...roots,
      ],
      30_000,
    );

    const files: LogFile[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length === 3) {
        files.push(
          // stat -c %Y is whole seconds, so this is a plain multiply.
          describe(parts[2]!.trim(), Number(parts[0]) || 0, Number(parts[1]) * 1000 || null),
        );
      } else {
        files.push(describe(line.trim(), 0, null));
      }
      if (files.length >= MAX_FILES * 4) break;
    }

    // Interesting first, then noise last, then most recently written.
    return files
      .sort((a, b) => {
        const rank = (f: LogFile) =>
          INTERESTING.some((p) => p.test(f.path)) ? 0 : f.noise ? 2 : 1;
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
      })
      .slice(0, MAX_FILES);
  }

  /**
   * Confines a requested path to the container's own mounts. Without this a
   * client could name any file the game server can read.
   */
  async function resolve(server: ServerConfig, requested: string): Promise<string> {
    const roots = await dataRootsOf(dockerClient, server);
    return resolveInsideAny(roots, requested);
  }

  /** Reads whatever has been appended since `offset`. */
  async function read(server: ServerConfig, path: string, offset: number): Promise<Chunk> {
    const output = await helpers.run(
      server.container,
      [...READER, path, String(Math.max(0, offset)), String(MAX_CHUNK)],
      30_000,
    );

    const newline = output.indexOf('\n');
    const header = newline === -1 ? output : output.slice(0, newline);
    const size = Number(/^SIZE (\d+)$/.exec(header.trim())?.[1] ?? 0);
    const body = newline === -1 ? '' : output.slice(newline + 1);

    // A file that shrank was rotated; the reader starts again from the top
    // rather than silently skipping whatever replaced it.
    if (size < offset) return { size, text: '', rotated: true };
    return { size, text: body, rotated: false };
  }

  return { list, resolve, read };
}

export type LogFileReader = ReturnType<typeof createLogFileReader>;
