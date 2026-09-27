export type Role = 'owner' | 'operator' | 'member';

/** May install, stop and start servers. */
export const canOperate = (role: Role): boolean => role === 'owner' || role === 'operator';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'owner',
  operator: 'operator',
  member: 'member',
};

export interface Me {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface AuthStatus {
  needsSetup: boolean;
  authenticated: boolean;
  mustChangePassword: boolean;
}

export interface PortalUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export type ContainerState =
  | 'running'
  | 'restarting'
  | 'paused'
  | 'exited'
  | 'created'
  | 'dead'
  | 'removing'
  | 'missing'
  | 'unknown';

export type JobPhase =
  | 'pending'
  | 'pulling'
  | 'stopping'
  | 'starting'
  | 'verifying'
  | 'done'
  | 'failed';

export interface JobView {
  id: string;
  phase: JobPhase;
  message: string;
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface GameServer {
  id: string;
  displayName: string;
  notes: string | null;
  updateStrategy: 'restart' | 'pull-recreate';
  accent: string | null;
  artworkStyle: 'poster' | 'icon' | 'none';
  status: {
    state: ContainerState;
    running: boolean;
    uptimeSeconds: number | null;
    health: 'healthy' | 'unhealthy' | 'starting' | 'none';
    exitCode: number | null;
    error: string | null;
  };
  players: { online: number; max: number | null; names: string[]; map: string | null } | null;
  cooldownSeconds: number;
  cooldownRemaining: number;
  lastRestartAt: number | null;
  activeJob: JobView | null;
}

export interface CatalogApp {
  id: string;
  name: string;
  repository: string;
  publisher: string;
  icon: string | null;
  overview: string;
  project: string | null;
  support: string | null;
  downloads: number;
}

export interface TemplateField {
  name: string;
  target: string;
  type: 'Path' | 'Variable' | 'Port' | 'Device' | 'Label' | 'other';
  mode: string;
  value: string;
  required: boolean;
  masked: boolean;
  description: string;
}

export interface CatalogTemplate {
  app: CatalogApp;
  template: {
    name: string;
    repository: string;
    network: string;
    privileged: boolean;
    icon: string | null;
    fields: TemplateField[];
  };
  suggestedName: string;
}

export interface MetricPoint {
  ts: number;
  cpuPercent: number;
  memBytes: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
  players: number | null;
}

export interface SettingField {
  key: string;
  value: string;
  masked: boolean;
  editable: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'other';
  size: number;
  editable: boolean;
}

export interface WorldInfo {
  name: string | null;
  seed: string | null;
  seedNumber: number | null;
  mapUrl: string | null;
  source: string;
}

export interface RouterProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
}

export interface RouterStatus {
  providers: Array<{ id: string; label: string; fields: RouterProviderField[] }>;
  lanAddress: string;
  configured: boolean;
  provider: string | null;
  config: Record<string, string>;
}

export interface ModSummary {
  source: string;
  id: string;
  name: string;
  summary: string;
  author: string;
  url: string;
  deprecated: boolean;
}

export interface Finding {
  id: string;
  label: string;
  state: 'pass' | 'warn' | 'fail' | 'unknown';
  summary: string;
  detail?: string;
}

export interface InstallPlan {
  source: string;
  modId: string;
  modName: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  targetDirectory: string;
  fileCount: number;
  archive: { files: number; totalBytes: number; peakRatio: number; extensions: Record<string, number> };
  scans: Array<{ scanner: string; label: string; state: string; summary: string; detail?: string }>;
  findings: Finding[];
  /** False when something refused outright; such a plan cannot be installed. */
  installable: boolean;
  /** True when it may proceed, but the operator is accepting a stated risk. */
  needsAcknowledgement: boolean;
}

export interface InstalledMod {
  source: string;
  modId: string;
  modName: string;
  version: string;
  sha256: string;
  files: string[];
  installedAt: number;
  installedBy: string;
}

export interface ModStatus {
  supported: boolean;
  reason?: string;
  source?: {
    id: string;
    label: string;
    searchable: boolean;
    lookupHint: string;
    loader: { id: string; label: string } | null;
  };
  running?: boolean;
  installed: InstalledMod[];
  scannerConfigured: boolean;
}

export interface ScannerSettings {
  virustotal: boolean;
  clamavHost: string;
  clamavPort: number;
}

export type CheckState = 'ok' | 'warn' | 'bad' | 'off' | 'unknown';

export interface HealthCheck {
  id: string;
  label: string;
  state: CheckState;
  summary: string;
  detail?: string;
  /** Where this connection's credential is kept. Never the credential itself. */
  secretHome?: string;
  facts: Array<{ k: string; v: string }>;
}

export interface HealthReport {
  checkedAt: number;
  checks: HealthCheck[];
}

export interface RequiredForward {
  proto: 'tcp' | 'udp' | 'tcp_udp';
  port: string;
  name: string;
  sensitive: boolean;
  reason?: string;
}

export interface PortForwardRule {
  id: string;
  name: string;
  proto: string;
  dstPort: string;
  fwd: string;
  fwdPort: string;
  enabled: boolean;
  managed: boolean;
}

export interface PortForwardState {
  configured: boolean;
  target: string;
  needed: RequiredForward[];
  missing: RequiredForward[];
  rules: PortForwardRule[];
}

export interface UnifiStatus {
  configured: boolean;
  host?: string;
  site?: string;
}

export interface ServerHistoryEntry {
  id: number;
  ts: number;
  username: string;
  action: string;
  result: string;
  detail: string | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  username: string;
  serverId: string | null;
  serverName: string | null;
  action: string;
  result: string;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Thrown for any non-2xx response so callers can branch on status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body as Record<string, unknown>);
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  // A content-type of application/json makes this a non-simple request, so a
  // cross-site form cannot forge it even before SameSite is considered.
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  me: () => request<Me>('/api/me'),

  setup: (token: string, username: string, password: string) =>
    request<{ username: string; role: Role }>('/api/auth/setup', json({ token, username, password })),
  login: (username: string, password: string) =>
    request<{ username: string; role: Role; mustChangePassword: boolean }>(
      '/api/auth/login',
      json({ username, password }),
    ),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', json({})),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', json({ currentPassword, newPassword })),

  servers: () => request<{ servers: GameServer[] }>('/api/servers'),
  server: (id: string) =>
    request<{ server: GameServer; history: ServerHistoryEntry[] }>(
      `/api/servers/${encodeURIComponent(id)}`,
    ),
  job: (jobId: string) => request<JobView>(`/api/jobs/${encodeURIComponent(jobId)}`),
  audit: (limit = 20) =>
    request<{ entries: AuditEntry[]; canSeeDetail: boolean; canSeeOrigin: boolean }>(
      `/api/audit?limit=${limit}`,
    ),
  start: (serverId: string) =>
    request<{ jobId: string }>(`/api/servers/${encodeURIComponent(serverId)}/start`, json({})),
  stop: (serverId: string) =>
    request<{ jobId: string }>(`/api/servers/${encodeURIComponent(serverId)}/stop`, json({})),

  metrics: (id: string, since: number) =>
    request<{ current: MetricPoint | null; history: MetricPoint[]; retentionMs: number }>(
      `/api/servers/${encodeURIComponent(id)}/metrics?since=${since}`,
    ),

  settings: (id: string) =>
    request<{ settings: SettingField[] }>(`/api/servers/${encodeURIComponent(id)}/settings`),
  applySettings: (id: string, changes: Record<string, string>) =>
    request<{ applied: string[]; steps: string[] }>(
      `/api/servers/${encodeURIComponent(id)}/settings`,
      json({ changes }),
    ),

  files: (id: string, path: string) =>
    request<{ roots: string[]; root: string; path: string; entries: FileEntry[] }>(
      `/api/servers/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
    ),
  readFile: (id: string, path: string) =>
    request<{ path: string; content: string }>(
      `/api/servers/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    ),
  writeFile: (id: string, path: string, content: string) =>
    request<{ path: string; backup: string | null; bytes: number; unchanged: boolean }>(
      `/api/servers/${encodeURIComponent(id)}/file`,
      { ...json({ path, content }), method: 'PUT' },
    ),

  portForwards: (id: string) =>
    request<PortForwardState>(`/api/servers/${encodeURIComponent(id)}/portforward`),
  openPortForwards: (id: string, ports: string[]) =>
    request<{ created: PortForwardRule[]; alreadyPresent: number }>(
      `/api/servers/${encodeURIComponent(id)}/portforward`,
      json({ ports }),
    ),
  closePortForward: (id: string, ruleId: string) =>
    request<{ ok: boolean }>(
      `/api/servers/${encodeURIComponent(id)}/portforward/${encodeURIComponent(ruleId)}`,
      { method: 'DELETE' },
    ),

  world: (id: string) => request<{ world: WorldInfo | null }>(`/api/servers/${encodeURIComponent(id)}/world`),

  createFile: (id: string, path: string) =>
    request<{ path: string }>(`/api/servers/${encodeURIComponent(id)}/file/new`, json({ path })),
  uploadFile: async (id: string, directory: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch(
      `/api/servers/${encodeURIComponent(id)}/file/upload?path=${encodeURIComponent(directory)}`,
      { method: 'POST', credentials: 'same-origin', body: form },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, body as Record<string, unknown>);
    return body as { path: string; bytes: number; replaced: boolean };
  },

  mods: (serverId: string) => request<ModStatus>(`/api/servers/${serverId}/mods`),
  searchMods: (serverId: string, q: string) =>
    request<{ results: ModSummary[] }>(
      `/api/servers/${serverId}/mods/search?q=${encodeURIComponent(q)}`,
    ),
  inspectMod: (serverId: string, mod: string, version?: string) =>
    request<{ plan: InstallPlan; mod: ModSummary }>(`/api/servers/${serverId}/mods/inspect`, {
      ...json({ mod, version }),
      method: 'POST',
    }),
  installMod: (serverId: string, mod: string, version: string, acknowledge: boolean) =>
    request<{ installed: true; plan: InstallPlan; files: number }>(
      `/api/servers/${serverId}/mods/install`,
      { ...json({ mod, version, acknowledge }), method: 'POST' },
    ),
  removeMod: (serverId: string, source: string, modId: string) =>
    request<{ removed: true }>(
      `/api/servers/${serverId}/mods/${encodeURIComponent(source)}/${encodeURIComponent(modId)}`,
      { method: 'DELETE' },
    ),

  scanners: () => request<ScannerSettings>('/api/integrations/scanners'),
  saveScanners: (body: { virustotalApiKey?: string; clamavHost?: string; clamavPort?: number }) =>
    request<{ ok: true }>('/api/integrations/scanners', { ...json(body), method: 'PUT' }),

  health: (refresh = false) =>
    request<HealthReport>(`/api/system/health${refresh ? '?refresh=1' : ''}`),

  router: () => request<RouterStatus>('/api/integrations/router'),
  connectRouter: (provider: string, config: Record<string, string>) =>
    request<{ configured: true; provider: string; detail: string }>(
      '/api/integrations/router',
      { ...json({ provider, config }), method: 'PUT' },
    ),
  disconnectRouter: () =>
    request<{ configured: false }>('/api/integrations/router', { method: 'DELETE' }),

  catalog: (q = '', refresh = false) =>
    request<{ apps: CatalogApp[]; total: number; fetchedAt: number; installed: string[] }>(
      `/api/catalog?q=${encodeURIComponent(q)}${refresh ? '&refresh=1' : ''}`,
    ),
  catalogTemplate: (id: string) =>
    request<CatalogTemplate>(`/api/catalog/${encodeURIComponent(id)}/template`),
  deploy: (body: {
    appId: string;
    name: string;
    variables: Record<string, string>;
    ports: Record<string, number>;
  }) =>
    request<{ serverId: string; container: string; appdataPath: string; unraidTemplate: string | null }>(
      '/api/catalog/deploy',
      json(body),
    ),

  restart: (serverId: string) =>
    request<{ jobId: string; phase: JobPhase; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/restart`,
      json({}),
    ),

  users: () => request<{ users: PortalUser[] }>('/api/users'),
  createUser: (username: string, role: Role) =>
    request<{ user: PortalUser; tempPassword: string }>('/api/users', json({ username, role })),
  resetPassword: (id: string) =>
    request<{ tempPassword: string }>(`/api/users/${encodeURIComponent(id)}/reset-password`, json({})),
  setRole: (id: string, role: Role) =>
    request<{ user: PortalUser }>(`/api/users/${encodeURIComponent(id)}/role`, json({ role })),
  setDisabled: (id: string, disabled: boolean) =>
    request<{ user: PortalUser }>(`/api/users/${encodeURIComponent(id)}/disabled`, json({ disabled })),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatRelative(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 45) return 'just now';
  return `${formatDuration(seconds)} ago`;
}

/** Artwork is served by the portal itself, never hotlinked from Steam. */
export function artworkUrl(serverId: string, kind: 'poster' | 'hero' | 'logo' | 'icon'): string {
  return `/artwork/${encodeURIComponent(serverId)}/${kind}`;
}

/** Deterministic hue per server, for the fallback tile when there is no art. */
export function fallbackHue(serverId: string): number {
  let hash = 0;
  for (let i = 0; i < serverId.length; i++) hash = (hash * 31 + serverId.charCodeAt(i)) % 360;
  return hash;
}
