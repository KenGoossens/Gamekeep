import { type AuditEntry, formatRelative } from '../api.ts';

const VERB: Record<string, string> = {
  restart: 'restarted',
  start: 'started',
  stop: 'stopped',
  'pull-recreate': 'updated',
  login: 'signed in',
  'login-failed': 'failed to sign in',
  logout: 'signed out',
  setup: 'created the portal',
  'user-created': 'added a user',
  'user-deleted': 'removed a user',
  'user-promoted': 'changed a role',
  'user-demoted': 'changed a role',
  'user-disabled': 'disabled a user',
  'user-enabled': 'enabled a user',
  'password-changed': 'changed their password',
  'password-reset': 'reset a password',
  'server-deployed': 'installed a server',
  'server-removed': 'removed a server',
};

/** Account changes read better from the detail line than from the verb. */
const ACCOUNT_ACTIONS = new Set([
  'user-created', 'user-deleted', 'user-promoted', 'user-demoted',
  'user-disabled', 'user-enabled', 'password-reset', 'server-deployed', 'server-removed',
]);

function describe(entry: AuditEntry): string {
  const verb = VERB[entry.action] ?? entry.action;
  const target = entry.serverName ? ` ${entry.serverName}` : '';
  if (ACCOUNT_ACTIONS.has(entry.action) && entry.detail) return entry.detail.toLowerCase();
  if (entry.result === 'success') return `${verb}${target}`;
  if (entry.result === 'unconfirmed') return `${verb}${target}, but it did not respond in time`;
  if (entry.result === 'cooldown') return `tried to restart${target} during the cooldown`;
  if (entry.result === 'busy') return `tried to restart${target} while it was already restarting`;
  if (entry.result === 'denied') return verb;
  return `failed to ${verb.replace(/ed$/, '')}${target}`;
}

/** "Chrome on Windows" is useful; the full user-agent string is not. */
function shortAgent(agent: string): string {
  const has = (needle: string) => agent.toLowerCase().includes(needle);

  const os = has("windows")
    ? "Windows"
    : has("android")
      ? "Android"
      : has("iphone") || has("ipad")
        ? "iOS"
        : has("mac os x")
          ? "macOS"
          : has("linux")
            ? "Linux"
            : null;

  // Order matters: Edge and Opera both also claim to be Chrome.
  const browser = has("edg")
    ? "Edge"
    : has("opr")
      ? "Opera"
      : has("firefox")
        ? "Firefox"
        : has("chrome")
          ? "Chrome"
          : has("safari")
            ? "Safari"
            : has("curl")
              ? "curl"
              : "unknown client";

  return os ? `${browser} on ${os}` : browser;
}
const FAILED = new Set(['denied', 'failure']);

export function AuditFeed({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="empty">Nothing yet. Activity will show up here.</p>;
  }

  return (
    <ul className="feed">
      {entries.map((entry) => (
        <li key={entry.id} className={FAILED.has(entry.result) ? 'failed' : undefined}>
          <span>
            <strong>{entry.username}</strong> {describe(entry)}
            {entry.detail && !ACCOUNT_ACTIONS.has(entry.action) ? (
              <span className="hint"> — {entry.detail}</span>
            ) : null}
            {entry.ip ? (
              <span className="origin">
                {entry.ip}
                {entry.userAgent ? ` · ${shortAgent(entry.userAgent)}` : ''}
              </span>
            ) : null}
          </span>
          <span className="when" title={new Date(entry.ts).toLocaleString()}>
            {formatRelative(entry.ts)}
          </span>
        </li>
      ))}
    </ul>
  );
}
