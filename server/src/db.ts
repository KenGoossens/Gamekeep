import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type AuditAction =
  | 'setup'
  | 'login'
  | 'login-failed'
  | 'logout'
  | 'restart'
  | 'start'
  | 'stop'
  | 'pull-recreate'
  | 'server-deployed'
  | 'server-removed'
  | 'settings-changed'
  | 'mod-install'
  | 'mod-remove'
  | 'logs-read'
  | 'access-granted'
  | 'access-revoked'
  | 'file-edited'
  | 'file-uploaded'
  | 'integration-changed'
  | 'portforward-opened'
  | 'portforward-closed'
  | 'user-created'
  | 'user-deleted'
  | 'user-promoted'
  | 'user-demoted'
  | 'user-disabled'
  | 'user-enabled'
  | 'password-changed'
  | 'password-reset'
  | 'schedule-created'
  | 'schedule-changed'
  | 'schedule-removed'
  | 'backup-created'
  | 'backup-restored'
  | 'backup-removed';


export type ScheduleAction = 'restart' | 'start' | 'stop' | 'backup';

export interface ScheduleRow {
  id: string;
  serverId: string;
  name: string;
  action: ScheduleAction;
  /** 'HH:MM' in the portal's own time zone. */
  time: string;
  /** Days of the week, 0 = Sunday. Empty means every day. */
  days: number[];
  skipOccupied: boolean;
  enabled: boolean;
  createdAt: number;
  createdBy: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: string | null;
}

interface RawScheduleRow {
  id: string;
  server_id: string;
  name: string;
  action: string;
  time_of_day: string;
  days: string;
  skip_occupied: number;
  enabled: number;
  created_at: number;
  created_by: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: string | null;
}

function toScheduleRow(raw: RawScheduleRow): ScheduleRow {
  let days: number[] = [];
  try {
    const parsed = JSON.parse(raw.days) as unknown;
    if (Array.isArray(parsed)) days = parsed.filter((d): d is number => Number.isInteger(d));
  } catch {
    // An unparsable day list behaves as "every day" rather than never firing.
  }
  return {
    id: raw.id,
    serverId: raw.server_id,
    name: raw.name,
    action: raw.action as ScheduleAction,
    time: raw.time_of_day,
    days,
    skipOccupied: raw.skip_occupied === 1,
    enabled: raw.enabled === 1,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    nextRunAt: raw.next_run_at,
    lastRunAt: raw.last_run_at,
    lastResult: raw.last_result,
  };
}

export type BackupKind = 'manual' | 'scheduled' | 'pre-restore';

export interface BackupRow {
  id: string;
  serverId: string;
  createdAt: number;
  createdBy: string;
  kind: BackupKind;
  /** File name inside BACKUP_DIR/<serverId>/, never a full path. */
  file: string;
  sizeBytes: number;
  /** Absolute container paths that went in. */
  paths: string[];
}

interface RawBackupRow {
  id: string;
  server_id: string;
  created_at: number;
  created_by: string;
  kind: string;
  file: string;
  size_bytes: number;
  paths: string;
}

function toBackupRow(raw: RawBackupRow): BackupRow {
  let paths: string[] = [];
  try {
    const parsed = JSON.parse(raw.paths) as unknown;
    if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    // A row with unreadable paths still lists and still restores.
  }
  return {
    id: raw.id,
    serverId: raw.server_id,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    kind: raw.kind as BackupKind,
    file: raw.file,
    sizeBytes: raw.size_bytes,
    paths,
  };
}

export type AuditResult =
  | 'success'
  | 'unconfirmed'
  | 'failure'
  | 'denied'
  | 'cooldown'
  | 'busy';

export interface AuditRow {
  id: number;
  ts: number;
  userId: string | null;
  username: string;
  serverId: string | null;
  action: AuditAction;
  result: AuditResult;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Three levels, so managing game servers can be delegated without also handing
 * over the accounts.
 *
 *   owner    - everything, including creating and removing users
 *   operator - install, stop, start and restart game servers; no user admin
 *   member   - restart only
 */
export type Role = 'owner' | 'operator' | 'member';

export const ROLES: Role[] = ['owner', 'operator', 'member'];

export const toRole = (value: unknown): Role =>
  value === 'owner' || value === 'operator' ? value : 'member';

/** May install, stop and start servers. */
export const canOperate = (role: Role): boolean => role === 'owner' || role === 'operator';

export interface UserRow {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
  createdBy: string | null;
  lastLoginAt: number | null;
}

export interface SessionUser extends UserRow {
  sessionId: string;
}

interface UserDbRow {
  id: string;
  username: string;
  role: string;
  must_change_password: number;
  disabled: number;
  created_at: number;
  created_by: string | null;
  last_login_at: number | null;
}

const toUser = (r: UserDbRow): UserRow => ({
  id: r.id,
  username: r.username,
  role: toRole(r.role),
  mustChangePassword: r.must_change_password === 1,
  disabled: r.disabled === 1,
  createdAt: r.created_at,
  createdBy: r.created_by,
  lastLoginAt: r.last_login_at,
});

const USER_COLUMNS =
  'id, username, role, must_change_password, disabled, created_at, created_by, last_login_at';

interface RawModRow {
  server_id: string;
  source: string;
  mod_id: string;
  mod_name: string;
  version: string;
  sha256: string;
  directory: string;
  files: string;
  report: string | null;
  installed_at: number;
  installed_by: string;
}

export interface ActiveSession {
  id: string;
  userId: string;
  username: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  ip: string | null;
  userAgent: string | null;
}

export interface InstalledModRow {
  serverId: string;
  source: string;
  modId: string;
  modName: string;
  version: string;
  sha256: string;
  directory: string;
  files: string[];
  report: unknown;
  installedAt: number;
  installedBy: string;
}

function toModRow(row: RawModRow): InstalledModRow {
  function parse<T>(text: string | null, fallback: T): T {
    try {
      return text ? (JSON.parse(text) as T) : fallback;
    } catch {
      // A row we cannot parse still describes an installed mod; only the extra
      // detail is lost, and losing that must not hide the mod itself.
      return fallback;
    }
  }

  return {
    serverId: row.server_id,
    source: row.source,
    modId: row.mod_id,
    modName: row.mod_name,
    version: row.version,
    sha256: row.sha256,
    directory: row.directory,
    files: parse<string[]>(row.files, []),
    report: parse<unknown>(row.report, null),
    installedAt: row.installed_at,
    installedBy: row.installed_by,
  };
}

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // The Discord-era schema keyed sessions and audit rows to a Discord id. Those
  // tables cannot describe a local account, and there were never any real
  // accounts in that shape, so rebuild rather than migrate.
  const tableExists = (table: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table) as { n: number })
      .n > 0;
  const hasColumn = (table: string, column: string) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  };
  if (hasColumn('sessions', 'discord_id')) {
    db.exec('DROP TABLE IF EXISTS sessions');
    db.exec('DROP TABLE IF EXISTS audit_log');
  }

  // Two roles became three. An existing administrator becomes the owner --
  // they were already trusted with everything -- and everyone else a member.
  if (hasColumn('users', 'is_admin') && !hasColumn('users', 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    db.exec("UPDATE users SET role = CASE WHEN is_admin = 1 THEN 'owner' ELSE 'member' END");
  }
  // Older audit rows simply have no address recorded.
  if (tableExists('audit_log') && !hasColumn('audit_log', 'ip')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN ip TEXT');
    db.exec('ALTER TABLE audit_log ADD COLUMN user_agent TEXT');
  }
    /*
     * Sessions used to record only when they began and when they expire,
     * which answers "how many are signed in" but not "who, from where, and
     * are they still there". Existing sessions keep working; they simply show
     * nothing for these until the next sign-in.
     */
    if (tableExists('sessions') && !hasColumn('sessions', 'ip')) {
      db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER');
    }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash        TEXT NOT NULL,
      role                 TEXT NOT NULL DEFAULT 'member',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disabled             INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      created_by           TEXT,
      last_login_at        INTEGER
    );

    /*
     * The last three columns are also added by an ALTER above, for databases
     * that predate them. They have to be here as well: a fresh install runs
     * that migration against a table that does not exist yet, skips it, and
     * then created a sessions table without them -- so the portal died on the
     * next line with "table sessions has no column named ip". Every existing
     * database reached this shape by the migration, so the two agree.
     */
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      ip           TEXT,
      user_agent   TEXT,
      last_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

    CREATE TABLE IF NOT EXISTS managed_servers (
      id                      TEXT PRIMARY KEY,
      definition              TEXT NOT NULL,
      created_at              INTEGER NOT NULL,
      created_by              TEXT
    );

    -- One row per mod this portal installed. The file list is what makes an
    -- uninstall exact rather than a guess, and the scan report is kept so an
    -- operator can see later what was known at the time it went in.
    CREATE TABLE IF NOT EXISTS installed_mods (
      server_id    TEXT NOT NULL,
      source       TEXT NOT NULL,
      mod_id       TEXT NOT NULL,
      mod_name     TEXT NOT NULL,
      version      TEXT NOT NULL,
      sha256       TEXT NOT NULL,
      directory    TEXT NOT NULL,
      files        TEXT NOT NULL,
      report       TEXT,
      installed_at INTEGER NOT NULL,
      installed_by TEXT NOT NULL,
      PRIMARY KEY (server_id, source, mod_id)
    );

    /*
     * One row per scheduled action. Times are HH:MM in the portal's own time
     * zone -- the scheduler is the only thing that evaluates them, so its
     * clock is the one that counts, and the API says which zone that is
     * rather than leaving people to guess. next_run_at is precomputed so the
     * ticker is one indexed comparison, and it is recomputed from "now" at
     * boot: a run missed while the portal was down is skipped, because a
     * 05:00 restart firing at 14:00 is worse than not firing at all.
     */
    CREATE TABLE IF NOT EXISTS schedules (
      id            TEXT PRIMARY KEY,
      server_id     TEXT NOT NULL,
      name          TEXT NOT NULL,
      action        TEXT NOT NULL,
      time_of_day   TEXT NOT NULL,
      days          TEXT NOT NULL,
      skip_occupied INTEGER NOT NULL DEFAULT 1,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      created_by    TEXT,
      next_run_at   INTEGER,
      last_run_at   INTEGER,
      last_result   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_server ON schedules (server_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (enabled, next_run_at);

    /*
     * One row per backup that exists on disk. The row is the catalogue; the
     * file under BACKUP_DIR is the backup. paths records exactly what went in,
     * because "what did this contain" is the first question a restore asks.
     */
    CREATE TABLE IF NOT EXISTS backups (
      id         TEXT PRIMARY KEY,
      server_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'manual',
      file       TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      paths      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backups_server ON backups (server_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      server_id   TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      cpu_percent REAL NOT NULL,
      mem_bytes   INTEGER NOT NULL,
      mem_limit   INTEGER NOT NULL,
      net_rx      INTEGER NOT NULL,
      net_tx      INTEGER NOT NULL,
      blk_read    INTEGER NOT NULL,
      blk_write   INTEGER NOT NULL,
      players     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_metrics ON metrics (server_id, ts DESC);

    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      user_id   TEXT,
      username  TEXT NOT NULL,
      server_id TEXT,
      action     TEXT NOT NULL,
      result     TEXT NOT NULL,
      detail     TEXT,
      ip         TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log (server_id, action, result, ts DESC);
  `);

  /*
   * Deployed servers used to have their restart timeout copied in from the
   * game registry at deploy time. That froze it: correcting a game's startup
   * time afterwards left every existing server on the old number, which is
   * how Project Zomboid kept reporting healthy restarts as unconfirmed on a
   * timeout of 300s while its mods were still downloading. Dropping the field
   * hands the decision back to the registry, where it is now read on every
   * restart. Nothing is lost: no part of the UI ever set this, so every value
   * in here is a copy rather than an operator's choice.
   */
  for (const row of db.prepare('SELECT id, definition FROM managed_servers').all() as {
    id: string;
    definition: string;
  }[]) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.definition);
    } catch {
      continue; // Left alone rather than dropped; the registry ignores it.
    }
    if (!('restartTimeoutSeconds' in parsed)) continue;
    delete parsed.restartTimeoutSeconds;
    db.prepare('UPDATE managed_servers SET definition = ? WHERE id = ?').run(
      JSON.stringify(parsed),
      row.id,
    );
  }

  const st = {
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countOwners: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0"),
    insertUser: db.prepare(
      `INSERT INTO users (id, username, password_hash, role, must_change_password, disabled, created_at, created_by)
       VALUES (@id, @username, @passwordHash, @role, @mustChangePassword, 0, @createdAt, @createdBy)`,
    ),
    userByName: db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ? COLLATE NOCASE`),
    userById: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`),
    listUsers: db.prepare(
      `SELECT ${USER_COLUMNS} FROM users
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, username COLLATE NOCASE`,
    ),
    setPassword: db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?',
    ),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

    insertSession: db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    /** Cheap enough to run often; see touchSession for why it is not. */
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
    listSessions: db.prepare(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.ip, s.user_agent, s.last_seen_at,
              u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > ?
        ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC`,
    ),
    sessionUser: db.prepare(
      `SELECT s.id AS session_id, ${USER_COLUMNS.split(', ').map((c) => 'u.' + c).join(', ')}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sweepSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    listManaged: db.prepare('SELECT id, definition FROM managed_servers ORDER BY created_at'),
    insertManaged: db.prepare(
      'INSERT INTO managed_servers (id, definition, created_at, created_by) VALUES (?, ?, ?, ?)',
    ),
    deleteManaged: db.prepare('DELETE FROM managed_servers WHERE id = ?'),

    listMods: db.prepare(
      'SELECT * FROM installed_mods WHERE server_id = ? ORDER BY mod_name'
    ),
    getMod: db.prepare(
      'SELECT * FROM installed_mods WHERE server_id = ? AND source = ? AND mod_id = ?'
    ),
    insertMod: db.prepare(
      `INSERT INTO installed_mods
         (server_id, source, mod_id, mod_name, version, sha256, directory, files, report, installed_at, installed_by)
       VALUES (@serverId, @source, @modId, @modName, @version, @sha256, @directory, @files, @report, @installedAt, @installedBy)
       ON CONFLICT(server_id, source, mod_id) DO UPDATE SET
         version = excluded.version, sha256 = excluded.sha256, directory = excluded.directory,
         files = excluded.files, report = excluded.report,
         installed_at = excluded.installed_at, installed_by = excluded.installed_by`
    ),
    deleteMod: db.prepare(
      'DELETE FROM installed_mods WHERE server_id = ? AND source = ? AND mod_id = ?'
    ),

    listSchedules: db.prepare('SELECT * FROM schedules WHERE server_id = ? ORDER BY time_of_day'),
    allSchedules: db.prepare('SELECT * FROM schedules ORDER BY server_id, time_of_day'),
    dueSchedules: db.prepare(
      'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    ),
    getSchedule: db.prepare('SELECT * FROM schedules WHERE id = ?'),
    countSchedules: db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE server_id = ?'),
    insertSchedule: db.prepare(
      `INSERT INTO schedules
         (id, server_id, name, action, time_of_day, days, skip_occupied, enabled, created_at, created_by, next_run_at)
       VALUES (@id, @serverId, @name, @action, @time, @days, @skipOccupied, @enabled, @createdAt, @createdBy, @nextRunAt)`,
    ),
    updateSchedule: db.prepare(
      `UPDATE schedules SET name = @name, action = @action, time_of_day = @time, days = @days,
         skip_occupied = @skipOccupied, enabled = @enabled, next_run_at = @nextRunAt
       WHERE id = @id`,
    ),
    recordScheduleRun: db.prepare(
      'UPDATE schedules SET last_run_at = @lastRunAt, last_result = @lastResult, next_run_at = @nextRunAt WHERE id = @id',
    ),
    noteScheduleResult: db.prepare('UPDATE schedules SET last_result = ? WHERE id = ?'),
    setScheduleNext: db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?'),
    deleteSchedule: db.prepare('DELETE FROM schedules WHERE id = ?'),
    deleteSchedulesFor: db.prepare('DELETE FROM schedules WHERE server_id = ?'),

    listBackups: db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC'),
    getBackup: db.prepare('SELECT * FROM backups WHERE id = ?'),
    insertBackup: db.prepare(
      `INSERT INTO backups (id, server_id, created_at, created_by, kind, file, size_bytes, paths)
       VALUES (@id, @serverId, @createdAt, @createdBy, @kind, @file, @sizeBytes, @paths)`,
    ),
    deleteBackup: db.prepare('DELETE FROM backups WHERE id = ?'),

    getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    deleteSetting: db.prepare('DELETE FROM app_settings WHERE key = ?'),

    insertMetric: db.prepare(
      `INSERT INTO metrics (server_id, ts, cpu_percent, mem_bytes, mem_limit, net_rx, net_tx, blk_read, blk_write, players)
       VALUES (@serverId, @ts, @cpuPercent, @memBytes, @memLimit, @netRx, @netTx, @blkRead, @blkWrite, @players)`,
    ),
    readMetrics: db.prepare(
      `SELECT ts, cpu_percent, mem_bytes, mem_limit, net_rx, net_tx, blk_read, blk_write, players
       FROM metrics WHERE server_id = ? AND ts >= ? ORDER BY ts`,
    ),
    pruneMetrics: db.prepare('DELETE FROM metrics WHERE ts < ?'),

    insertAudit: db.prepare(
      `INSERT INTO audit_log (ts, user_id, username, server_id, action, result, detail, ip, user_agent)
       VALUES (@ts, @userId, @username, @serverId, @action, @result, @detail, @ip, @userAgent)`,
    ),
    recentAudit: db.prepare(
      `SELECT id, ts, user_id, username, server_id, action, result, detail, ip, user_agent
       FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?`,
    ),
    lastSuccessfulAction: db.prepare(
      `SELECT MAX(ts) AS ts FROM audit_log
       WHERE server_id = ? AND result IN ('success', 'unconfirmed')
         AND action IN ('restart', 'pull-recreate')`,
    ),
    /*
     * Any deliberate action, including a stop -- which the one above must not
     * count, since a stop should not start a restart cooldown. Used to tell a
     * server someone switched off from one that fell over.
     */
    lastServerAction: db.prepare(
      `SELECT MAX(ts) AS ts FROM audit_log
       WHERE server_id = ? AND action IN ('restart', 'pull-recreate', 'start', 'stop')`,
    ),
  };

  return {
    raw: db,

    userCount: () => (st.countUsers.get() as { n: number }).n,
    /** Disabled admins do not count -- they cannot act. */
    activeOwnerCount: () => (st.countOwners.get() as { n: number }).n,

    createUser(user: {
      id: string;
      username: string;
      passwordHash: string;
      role: Role;
      mustChangePassword: boolean;
      createdBy: string | null;
    }) {
      st.insertUser.run({
        id: user.id,
        username: user.username,
        passwordHash: user.passwordHash,
        role: user.role,
        mustChangePassword: user.mustChangePassword ? 1 : 0,
        createdAt: Date.now(),
        createdBy: user.createdBy,
      });
    },

    /** Returns the stored hash alongside the user, for login only. */
    findByUsername(username: string): (UserRow & { passwordHash: string }) | undefined {
      const row = st.userByName.get(username) as unknown as (UserDbRow & { password_hash: string }) | undefined;
      return row ? { ...toUser(row), passwordHash: row.password_hash } : undefined;
    },

    findById(id: string): UserRow | undefined {
      const row = st.userById.get(id) as unknown as UserDbRow | undefined;
      return row ? toUser(row) : undefined;
    },

    listUsers: (): UserRow[] => (st.listUsers.all() as unknown as UserDbRow[]).map(toUser),

    setPassword(userId: string, passwordHash: string, mustChange: boolean) {
      st.setPassword.run(passwordHash, mustChange ? 1 : 0, userId);
    },
    setRole: (userId: string, role: Role) => void st.setRole.run(role, userId),
    setDisabled: (userId: string, disabled: boolean) => void st.setDisabled.run(disabled ? 1 : 0, userId),
    touchLogin: (userId: string) => void st.touchLogin.run(Date.now(), userId),
    /** Sessions cascade, so a deleted user is logged out everywhere at once. */
    deleteUser: (userId: string) => void st.deleteUser.run(userId),

    /**
     * Servers deployed through the portal. The config file stays read-only --
     * it is the static whitelist -- and anything the portal creates itself is
     * recorded here instead. Both sources are merged by the server registry.
     */
    listManagedServers(): Array<{ id: string; definition: unknown }> {
      const rows = st.listManaged.all() as unknown as Array<{ id: string; definition: string }>;
      return rows.flatMap((row) => {
        try {
          return [{ id: row.id, definition: JSON.parse(row.definition) as unknown }];
        } catch {
          // A row we cannot parse is skipped rather than crashing the portal.
          return [];
        }
      });
    },

    addManagedServer(id: string, definition: unknown, createdBy: string | null) {
      st.insertManaged.run(id, JSON.stringify(definition), Date.now(), createdBy);
    },

    removeManagedServer(id: string) {
      st.deleteManaged.run(id);
    },

    listSchedules(serverId: string): ScheduleRow[] {
      return (st.listSchedules.all(serverId) as unknown as RawScheduleRow[]).map(toScheduleRow);
    },

    allSchedules(): ScheduleRow[] {
      return (st.allSchedules.all() as unknown as RawScheduleRow[]).map(toScheduleRow);
    },

    dueSchedules(now: number): ScheduleRow[] {
      return (st.dueSchedules.all(now) as unknown as RawScheduleRow[]).map(toScheduleRow);
    },

    getSchedule(id: string): ScheduleRow | null {
      const raw = st.getSchedule.get(id) as RawScheduleRow | undefined;
      return raw ? toScheduleRow(raw) : null;
    },

    countSchedules(serverId: string): number {
      return Number((st.countSchedules.get(serverId) as { n: number }).n);
    },

    addSchedule(row: {
      id: string;
      serverId: string;
      name: string;
      action: ScheduleAction;
      time: string;
      days: number[];
      skipOccupied: boolean;
      enabled: boolean;
      createdBy: string | null;
      nextRunAt: number | null;
    }) {
      st.insertSchedule.run({
        id: row.id,
        serverId: row.serverId,
        name: row.name,
        action: row.action,
        time: row.time,
        days: JSON.stringify(row.days),
        skipOccupied: row.skipOccupied ? 1 : 0,
        enabled: row.enabled ? 1 : 0,
        createdAt: Date.now(),
        createdBy: row.createdBy,
        nextRunAt: row.nextRunAt,
      });
    },

    updateSchedule(row: {
      id: string;
      name: string;
      action: ScheduleAction;
      time: string;
      days: number[];
      skipOccupied: boolean;
      enabled: boolean;
      nextRunAt: number | null;
    }) {
      st.updateSchedule.run({
        id: row.id,
        name: row.name,
        action: row.action,
        time: row.time,
        days: JSON.stringify(row.days),
        skipOccupied: row.skipOccupied ? 1 : 0,
        enabled: row.enabled ? 1 : 0,
        nextRunAt: row.nextRunAt,
      });
    },

    recordScheduleRun(id: string, run: { lastRunAt: number; lastResult: string; nextRunAt: number | null }) {
      st.recordScheduleRun.run({ id, ...run });
    },

    /** Updates only the outcome text, once a run's job has settled. */
    noteScheduleResult(id: string, result: string) {
      st.noteScheduleResult.run(result, id);
    },

    /** Moves only the next run, leaving the last run's history alone. */
    setScheduleNextRun(id: string, nextRunAt: number | null) {
      st.setScheduleNext.run(nextRunAt, id);
    },

    removeSchedule(id: string) {
      st.deleteSchedule.run(id);
    },

    removeSchedulesFor(serverId: string) {
      st.deleteSchedulesFor.run(serverId);
    },

    listBackups(serverId: string): BackupRow[] {
      return (st.listBackups.all(serverId) as unknown as RawBackupRow[]).map(toBackupRow);
    },

    getBackup(id: string): BackupRow | null {
      const raw = st.getBackup.get(id) as RawBackupRow | undefined;
      return raw ? toBackupRow(raw) : null;
    },

    addBackup(row: {
      id: string;
      serverId: string;
      createdBy: string;
      kind: BackupKind;
      file: string;
      sizeBytes: number;
      paths: string[];
    }) {
      st.insertBackup.run({
        id: row.id,
        serverId: row.serverId,
        createdAt: Date.now(),
        createdBy: row.createdBy,
        kind: row.kind,
        file: row.file,
        sizeBytes: row.sizeBytes,
        paths: JSON.stringify(row.paths),
      });
    },

    removeBackup(id: string) {
      st.deleteBackup.run(id);
    },

    listInstalledMods(serverId: string): InstalledModRow[] {
      return (st.listMods.all(serverId) as unknown as RawModRow[]).map(toModRow);
    },

    getInstalledMod(serverId: string, source: string, modId: string): InstalledModRow | null {
      const row = st.getMod.get(serverId, source, modId) as RawModRow | undefined;
      return row ? toModRow(row) : null;
    },

    recordInstalledMod(row: {
      serverId: string;
      source: string;
      modId: string;
      modName: string;
      version: string;
      sha256: string;
      directory: string;
      files: string[];
      report: unknown;
      installedBy: string;
    }) {
      st.insertMod.run({
        ...row,
        files: JSON.stringify(row.files),
        report: JSON.stringify(row.report ?? null),
        installedAt: Date.now(),
      });
    },

    forgetInstalledMod(serverId: string, source: string, modId: string) {
      st.deleteMod.run(serverId, source, modId);
    },

    /** Small encrypted key/value store for integration credentials. */
    getSetting(key: string): string | null {
      const row = st.getSetting.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setSetting: (key: string, value: string) => void st.setSetting.run(key, value),
    deleteSetting: (key: string) => void st.deleteSetting.run(key),

    recordMetric(
      serverId: string,
      point: {
        ts: number;
        cpuPercent: number;
        memBytes: number;
        memLimit: number;
        netRx: number;
        netTx: number;
        blkRead: number;
        blkWrite: number;
        players: number | null;
      },
    ) {
      st.insertMetric.run({ serverId, ...point });
    },

    readMetrics(serverId: string, since: number) {
      const rows = st.readMetrics.all(serverId, since) as unknown as Array<Record<string, number | null>>;
      return rows.map((r) => ({
        ts: r.ts as number,
        cpuPercent: r.cpu_percent as number,
        memBytes: r.mem_bytes as number,
        memLimit: r.mem_limit as number,
        netRx: r.net_rx as number,
        netTx: r.net_tx as number,
        blkRead: r.blk_read as number,
        blkWrite: r.blk_write as number,
        players: r.players as number | null,
      }));
    },

    /** Keeps the table bounded; called after every collection round. */
    pruneMetrics: (before: number) => void st.pruneMetrics.run(before),

    createSession(
      id: string,
      userId: string,
      expiresAt: number,
      origin: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null },
    ) {
      const now = Date.now();
      st.insertSession.run(id, userId, now, expiresAt, origin.ip, origin.userAgent, now);
    },

    /**
     * Records that a session is still in use.
     *
     * Deliberately not called on every request: that would be a write per
     * request on a database whose whole appeal is that it is one file. Once a
     * minute is precise enough to answer "is this person still here" and costs
     * almost nothing.
     */
    touchSession(id: string, seenAt: number) {
      st.touchSession.run(seenAt, id);
    },

    listActiveSessions(): ActiveSession[] {
      const rows = st.listSessions.all(Date.now()) as unknown as Array<{
        id: string;
        user_id: string;
        username: string;
        role: Role;
        created_at: number;
        expires_at: number;
        ip: string | null;
        user_agent: string | null;
        last_seen_at: number | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        ip: row.ip,
        userAgent: row.user_agent,
      }));
    },

    /**
     * Resolves a session to its user in one query. A disabled account still has
     * rows here; the caller is responsible for rejecting it.
     */
    sessionUser(sessionId: string): SessionUser | undefined {
      const row = st.sessionUser.get(sessionId, Date.now()) as unknown as
        | (UserDbRow & { session_id: string })
        | undefined;
      return row ? { ...toUser(row), sessionId: row.session_id } : undefined;
    },

    deleteSession: (id: string) => void st.deleteSession.run(id),
    /** Used on password change, demotion, disable and delete. */
    deleteUserSessions: (userId: string) => void st.deleteUserSessions.run(userId),
    sweepExpiredSessions: () => Number(st.sweepSessions.run(Date.now()).changes),

    /**
     * Every attempt is recorded, including the refusals. The refusals are the
     * interesting rows: a failed login or a burst of cooldown hits is what you
     * actually want to see after the fact. The username is denormalised so the
     * history stays readable after an account is deleted.
     */
    audit(entry: {
      userId: string | null;
      username: string;
      serverId: string | null;
      action: AuditAction;
      result: AuditResult;
      detail?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    }) {
      st.insertAudit.run({
        ts: Date.now(),
        userId: entry.userId,
        username: entry.username,
        serverId: entry.serverId,
        action: entry.action,
        result: entry.result,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ? entry.userAgent.slice(0, 300) : null,
      });
    },

    recentAudit(limit: number): AuditRow[] {
      const rows = st.recentAudit.all(limit) as unknown as Array<{
        id: number;
        ts: number;
        user_id: string | null;
        username: string;
        server_id: string | null;
        action: AuditAction;
        result: AuditResult;
        detail: string | null;
        ip: string | null;
        user_agent: string | null;
      }>;
      return rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        userId: r.user_id,
        username: r.username,
        serverId: r.server_id,
        action: r.action,
        result: r.result,
        detail: r.detail,
        ip: r.ip,
        userAgent: r.user_agent,
      }));
    },

    /**
     * Cooldown is derived from the audit log rather than from memory, so it
     * survives a restart of the portal itself. 'unconfirmed' counts too: the
     * container did restart, the game just never answered, and that server is
     * most likely still loading.
     */
    lastSuccessfulActionAt(serverId: string): number | null {
      const row = st.lastSuccessfulAction.get(serverId) as { ts: number | null } | undefined;
      return row?.ts ?? null;
    },

    lastServerActionAt(serverId: string): number | null {
      const row = st.lastServerAction.get(serverId) as { ts: number | null } | undefined;
      return row?.ts ?? null;
    },
  };
}

export type Db = ReturnType<typeof openDatabase>;
