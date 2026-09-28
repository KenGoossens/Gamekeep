import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';
import type { BackupKind, BackupRow, Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import { createHelperRunner } from './docker/helper.js';
import { dataRootsOf } from './files.js';
import { gameByQueryType, type GameProfile } from './games.js';

/**
 * World backups: the one feature that protects something instead of managing it.
 *
 * A game install is redownloadable; the world is not. One corrupted save --
 * a bad mod, a crash mid-write, a botched restore by hand -- and months of a
 * shared world are simply gone. So this backs up the small, irreplaceable
 * part, not the tens of gigabytes SteamCMD can fetch again.
 *
 * What goes in is chosen, not guessed. The game registry suggests where saves
 * live (searched for inside the container, since every image roots the game
 * somewhere else), the operator confirms, and the choice is stored. A backup
 * with no configured paths is refused rather than silently backing up the
 * wrong thing.
 *
 * The mechanics stream nothing through this process: a helper container sees
 * the game's volumes and the portal's own at once, and tar reads from one
 * straight into the other. That is also why the archive lands in the portal's
 * data volume -- it survives the game container being recreated, which is the
 * entire point, and it is covered by whatever backs up appdata itself.
 *
 * Restores are stricter than backups. A backup of a running server is allowed
 * (games flush their saves continually, and a mostly-consistent backup beats
 * none), but a restore only happens while the server is stopped, and never
 * without first making a pre-restore backup of what is about to be replaced.
 */

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** How many backups to keep per server before the oldest is dropped. */
const KEEP = 10;
/** A large modded world takes a while to compress; a deadline, not a wait. */
const TAR_TIMEOUT_MS = 15 * 60_000;

const PATHS_KEY = (serverId: string) => `backup-paths:${serverId}`;

export function createBackupService(deps: { docker: DockerClient; db: Db; backupDir: string }) {
  const { docker, db, backupDir } = deps;
  const helpers = createHelperRunner(docker);

  /** One backup at a time per server: two tars of the same world race badly. */
  const busy = new Set<string>();

  function configuredPaths(serverId: string): string[] {
    const raw = db.getSetting(PATHS_KEY(serverId));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Validates and stores what to back up: absolute container paths, each
   * confined to one of the server's own mounts. A path outside a mount would
   * be backing up the image, which does not survive a recreate and is never
   * what anyone means.
   */
  async function setPaths(server: ServerConfig, paths: string[]): Promise<string[]> {
    const roots = await dataRootsOf(docker, server);
    const cleaned: string[] = [];
    for (const raw of paths) {
      const path = raw.trim().replace(/\/+$/, '');
      if (!path.startsWith('/') || path.includes('\0') || path.includes('..')) {
        throw new BackupError(`${raw} is not an absolute container path.`, 'bad-path');
      }
      /*
       * Strictly on a mount, checked as a prefix and not through the file
       * browser's resolver: that resolver retries a non-matching path as
       * relative, which is right for browsing and wrong here. A path outside
       * the mounts does not even belong to the game -- the helper would tar
       * its own image's filesystem and call it a backup.
       */
      const inside = roots.some((r) => path === r || path.startsWith(`${r}/`));
      if (!inside) {
        throw new BackupError(
          `${path} is not inside this server's data directories (${roots.join(', ')}), so it would not survive the container being recreated.`,
          'bad-path',
        );
      }
      if (!cleaned.includes(path)) cleaned.push(path);
    }
    if (cleaned.length > 12) {
      throw new BackupError('That is too many paths. Back up directories, not files.', 'bad-path');
    }
    db.setSetting(PATHS_KEY(server.id), JSON.stringify(cleaned));
    return cleaned;
  }

  /**
   * Where this game's saves probably live, found rather than assumed: the
   * registry names directory suffixes and the container is searched for them.
   */
  async function suggest(server: ServerConfig, game: GameProfile | null): Promise<string[]> {
    const suffixes = game?.saves ?? [];
    if (suffixes.length === 0) return [];

    // One find for all suffixes: ( -path '*/a' -o -path '*/b' )
    const tests = suffixes.flatMap((s, i) => [
      ...(i > 0 ? ['-o'] : []),
      '-path',
      `*/${s}`,
    ]);
    let output = '';
    try {
      output = await helpers.run(
        server.container,
        ['find', '/', '-maxdepth', '9', '-type', 'd', '(', ...tests, ')', '-print'],
        60_000,
      );
    } catch {
      return [];
    }

    const roots = await dataRootsOf(docker, server).catch(() => [] as string[]);
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // Only paths that live on a mount are worth suggesting; anything else
      // vanishes with the container.
      .filter((p) => roots.some((r) => p === r || p.startsWith(`${r}/`)))
      .sort();
  }

  async function ensureDir(serverId: string): Promise<string> {
    const dir = join(backupDir, serverId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** The archive's location as both this process and the helper see it. */
  function fileFor(serverId: string, file: string): { local: string; inHelper: string } {
    return {
      local: join(backupDir, serverId, file),
      // Forward slashes on purpose: the helper is a Linux container even when
      // this process is not.
      inHelper: `${backupDir.replace(/\\/g, '/')}/${serverId}/${file}`,
    };
  }

  async function make(
    server: ServerConfig,
    options: { actor: string; kind: BackupKind },
  ): Promise<BackupRow> {
    const paths = configuredPaths(server.id);
    if (paths.length === 0) {
      throw new BackupError(
        'Nothing is configured to back up yet. Choose what matters on the Backups tab first.',
        'not-configured',
      );
    }
    if (busy.has(server.id)) {
      throw new BackupError('A backup of this server is already being made.', 'busy');
    }
    busy.add(server.id);
    try {
      await ensureDir(server.id);
      const id = randomUUID();
      const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.kind}.tar.gz`;
      const { local, inHelper } = fileFor(server.id, file);

      /*
       * Member names keep the full path minus the leading slash, so a restore
       * with -C / puts everything back exactly where it came from, whichever
       * mount it lives on. Paths were validated when configured; the argv
       * array means none of them is ever parsed as an option or a command.
       */
      const members = paths.map((p) => p.replace(/^\//, ''));
      try {
        await helpers.runJoined(
          [server.container, hostname()],
          ['tar', 'czf', inHelper, '-C', '/', ...members],
          TAR_TIMEOUT_MS,
        );
      } catch (err) {
        await rm(local, { force: true }).catch(() => {});
        throw new BackupError(
          `The backup failed: ${(err as Error).message}. If a path no longer exists, adjust what to back up.`,
          'tar-failed',
        );
      }

      const size = (await stat(local)).size;
      db.addBackup({
        id,
        serverId: server.id,
        createdBy: options.actor,
        kind: options.kind,
        file,
        sizeBytes: size,
        paths,
      });

      await prune(server.id);
      return db.getBackup(id)!;
    } finally {
      busy.delete(server.id);
    }
  }

  /**
   * Puts a backup's contents back where they came from.
   *
   * An overlay, not a wipe: files that exist in the backup are replaced,
   * files created since are left alone. Wiping directories the operator did
   * not name is how a restore becomes a second disaster. The caller has
   * already made the pre-restore backup and verified the server is stopped.
   */
  async function restore(server: ServerConfig, backup: BackupRow): Promise<void> {
    const { local, inHelper } = fileFor(server.id, backup.file);
    try {
      await stat(local);
    } catch {
      throw new BackupError(
        'The backup file is gone from disk. It may have been removed outside the portal.',
        'file-missing',
      );
    }
    await helpers.runJoined(
      [server.container, hostname()],
      ['tar', 'xzf', inHelper, '-C', '/'],
      TAR_TIMEOUT_MS,
    );
  }

  async function remove(backup: BackupRow): Promise<void> {
    const { local } = fileFor(backup.serverId, backup.file);
    await rm(local, { force: true }).catch(() => {});
    db.removeBackup(backup.id);
  }

  /** Oldest first, keeping pre-restore copies out of the count and the cull. */
  async function prune(serverId: string): Promise<void> {
    const rows = db.listBackups(serverId).filter((b) => b.kind !== 'pre-restore');
    for (const old of rows.slice(KEEP)) {
      await remove(old);
    }
  }

  function localPath(backup: BackupRow): string {
    return fileFor(backup.serverId, backup.file).local;
  }

  /** For the schedule row: what a scheduled run should say it made. */
  function describe(backup: BackupRow): string {
    const mb = backup.sizeBytes / (1024 * 1024);
    return `backed up ${backup.paths.length} ${backup.paths.length === 1 ? 'path' : 'paths'} (${
      mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`
    })`;
  }

  function suggestFor(server: ServerConfig): Promise<string[]> {
    return suggest(server, gameByQueryType(server.query?.type));
  }

  return { configuredPaths, setPaths, suggest: suggestFor, make, restore, remove, localPath, describe };
}

export type BackupService = ReturnType<typeof createBackupService>;
