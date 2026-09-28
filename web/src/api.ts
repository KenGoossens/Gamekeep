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

export interface NotifySettings {
  configured: boolean;
  events: string[];
  available: Array<{ kind: string; label: string }>;
}

export interface LogFile {
  path: string;
  label: string;
  sizeBytes: number;
  modifiedAt: number | null;
  /** Steam client chatter rather than the game's own log. */
  noise: boolean;
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
  /** True for the browser making this request. */
  current: boolean;
}

export interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  emails: string[];
  otherIncludes: number;
  requireRules: number;
  excludeRules: number;
  appCount: number;
}

export interface AccessStatus {
  configured: boolean;
  canConfigure: boolean;
  accountId?: string;
  policy?: AccessPolicy;
  message?: string;
}

export interface DashboardServer {
  id: string;
  displayName: string;
  state: string;
  running: boolean;
  uptimeSeconds: number | null;
  health: string | null;
  players: { online: number; max: number | null; names: string[] } | null;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimit: number | null;
  accent: string | null;
}

export interface Dashboard {
  generatedAt: number;
  windowMs: number;
  servers: DashboardServer[];
  series: Array<{
    id: string;
    label: string;
    points: Array<{ ts: number; cpu: number; mem: number; players: number | null }>;
  }>;
  totals: { servers: number; running: number; players: number; capacity: number };
  outcomes: Record<string, number>;
  activeJobs: Array<{ serverId: string; phase: string; message: string; actor: string | null }>;
  recent: Array<{
    id: number;
    ts: number;
    username: string;
    serverId: string | null;
    action: string;
    result: string;
    detail: string | null;
  }>;
}

export interface ModSummary {
  source: string;
  id: string;
  name: string;
  summary: string;
  author: string;
  url: string;
  deprecated: boolean;
  /** Null when the repository does not say, which is not the same as false. */
  serverSupported?: boolean | null;
}

export interface Finding {
  id: string;
  label: string;
  state: 'pass' | 'warn' | 'fail' | 'unknown';
  summary: string;
  detail?: string;
}

export interface ExtraParameters {
  variables: Array<{ name: string; value: string }>;
  ports: Array<{ container: number; host: number; protocol: 'tcp' | 'udp' }>;
  /** A container path plus a folder name; never a host path. */
  paths: Array<{ container: string; name: string }>;
}

export interface ImageFacts {
  digest: string | null;
  createdAt: string | null;
  user: string | null;
  architecture: string | null;
  os: string | null;
  exposedPorts: string[];
}

export interface DeployReview {
  app: CatalogApp;
  findings: Finding[];
  image: ImageFacts | null;
  deployable: boolean;
  needsAcknowledgement: boolean;
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
  /**
   * 'repository' means the portal fetches the mod and installs the files.
   * 'workshop' means the game fetches its own: the portal writes the id into
   * the server's config and the mod arrives on the next start. Two different
   * screens, because they are two different things.
   */
  mode?: 'repository' | 'workshop';
  note?: string;
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

export interface WorkshopVerdict {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

export interface WorkshopItem {
  id: string;
  title: string;
  authorId: string;
  authorUrl: string;
  url: string;
  appId: number;
  description: string;
  previewUrl: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  subscriptions: number | null;
  banned: boolean;
  banReason: string | null;
  declaredModIds: string[];
  verdict?: WorkshopVerdict;
}

export interface WorkshopList {
  file: string;
  running: boolean;
  note: string;
  usesModIds: boolean;
  modIds: string[];
  items: WorkshopItem[];
  /** Declared on this server, but Steam has nothing for them any more. */
  unknown: string[];
  lookupError: string | null;
}

export type ScheduleAction = 'restart' | 'start' | 'stop' | 'backup';

export interface Schedule {
  id: string;
  name: string;
  action: ScheduleAction;
  /** 'HH:MM' in the portal's time zone. */
  time: string;
  /** Days of the week, 0 = Sunday. Empty means every day. */
  days: number[];
  skipOccupied: boolean;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: string | null;
}

export interface ScheduleList {
  schedules: Schedule[];
  actions: ScheduleAction[];
  /** The zone the portal's clock runs in -- what "05:00" actually means. */
  timezone: string;
  serverTime: string;
}

export interface ScheduleInput {
  name?: string;
  action: ScheduleAction;
  time: string;
  days: number[];
  skipOccupied: boolean;
  enabled?: boolean;
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

export interface PublicAddress {
  /** Null when it could not be looked up; `error` then says why. */
  ip: string | null;
  source: string | null;
  checkedAt: number;
  error?: string;
}

export interface PortForwardState {
  configured: boolean;
  /** The LAN address forwards point at. */
  target: string;
  /** The address the outside world sees — what a friend actually connects to. */
  publicAddress: PublicAddress;
  needed: RequiredForward[];
  missing: RequiredForward[];
  rules: PortForwardRule[];
  /**
   * Ports the game needs that the container never published, which no amount
   * of forwarding can fix. `known` is false when the game is not in the
   * registry — "we checked and it is fine" and "we cannot say" must not look
   * the same.
   */
  unpublished: {
    known: boolean;
    missing: Array<{ port: number; protocol: 'tcp' | 'udp'; purpose: string; required: boolean }>;
  };
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

  notifications: () => request<NotifySettings>('/api/integrations/notifications'),
  saveNotifications: (webhook: string | undefined, events: string[]) =>
    request<{ configured: true; events: string[] }>('/api/integrations/notifications', {
      ...json({ webhook, events }),
      method: 'PUT',
    }),
  disableNotifications: () =>
    request<{ configured: false }>('/api/integrations/notifications', { method: 'DELETE' }),

  logFiles: (serverId: string) =>
    request<{ files: LogFile[] }>(`/api/servers/${encodeURIComponent(serverId)}/logs/files`),
  logFile: (serverId: string, file: string, offset: number) =>
    request<{ path: string; size: number; text: string; rotated: boolean }>(
      `/api/servers/${encodeURIComponent(serverId)}/logs/file?file=${encodeURIComponent(file)}&offset=${offset}`,
    ),

  sessions: () => request<{ sessions: ActiveSession[] }>('/api/sessions'),
  signOutSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  access: () => request<AccessStatus>('/api/integrations/access'),
  accessPolicies: (token: string, accountId: string) =>
    request<{ policies: AccessPolicy[] }>('/api/integrations/access/policies', {
      ...json({ token, accountId }),
      method: 'POST',
    }),
  connectAccess: (token: string, accountId: string, policyId: string) =>
    request<{ configured: true; detail: string; policy: AccessPolicy }>(
      '/api/integrations/access',
      { ...json({ token, accountId, policyId }), method: 'PUT' },
    ),
  disconnectAccess: () =>
    request<{ configured: false }>('/api/integrations/access', { method: 'DELETE' }),
  addAccessEmail: (email: string) =>
    request<{ policy: AccessPolicy }>('/api/integrations/access/emails', {
      ...json({ email }),
      method: 'POST',
    }).then((r) => r.policy),
  removeAccessEmail: (email: string) =>
    request<{ policy: AccessPolicy }>(
      `/api/integrations/access/emails/${encodeURIComponent(email)}`,
      { method: 'DELETE' },
    ).then((r) => r.policy),

  dashboard: (windowMs: number) =>
    request<Dashboard>(`/api/dashboard?window=`),

  mods: (serverId: string) => request<ModStatus>(`/api/servers/${serverId}/mods`),

  schedules: (serverId: string) =>
    request<ScheduleList>(`/api/servers/${encodeURIComponent(serverId)}/schedules`),
  createSchedule: (serverId: string, input: ScheduleInput) =>
    request<{ schedule: Schedule }>(`/api/servers/${encodeURIComponent(serverId)}/schedules`, {
      ...json(input),
      method: 'POST',
    }),
  updateSchedule: (serverId: string, scheduleId: string, input: Partial<ScheduleInput>) =>
    request<{ schedule: Schedule }>(
      `/api/servers/${encodeURIComponent(serverId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { ...json(input), method: 'PATCH' },
    ),
  deleteSchedule: (serverId: string, scheduleId: string) =>
    request<{ removed: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'DELETE' },
    ),

  workshop: (serverId: string) =>
    request<WorkshopList>(`/api/servers/${encodeURIComponent(serverId)}/workshop`),
  lookupWorkshop: (serverId: string, ref: string) =>
    request<{
      item: WorkshopItem;
      verdict: WorkshopVerdict;
      alreadyDeclared: boolean;
      usesModIds: boolean;
    }>(
      `/api/servers/${encodeURIComponent(serverId)}/workshop/lookup?ref=${encodeURIComponent(ref)}`,
    ),
  declareWorkshop: (serverId: string, reference: string) =>
    request<{ item: WorkshopItem; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/workshop`,
      { ...json({ reference }), method: 'POST' },
    ),
  undeclareWorkshop: (serverId: string, itemId: string) =>
    request<{ removed: string; message: string }>(
      `/api/servers/${encodeURIComponent(serverId)}/workshop/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),

  searchMods: (serverId: string, q: string) =>
    request<{ results: ModSummary[]; hidden: number }>(
      `/api/servers/${serverId}/mods/search?q=${encodeURIComponent(q)}`,
    ),
  inspectMod: (serverId: string, mod: string, version?: string) =>
    request<{ plan: InstallPlan; mod: ModSummary }>(`/api/servers/${serverId}/mods/inspect`, {
      ...json({ mod, version }),
      method: 'POST',
    }),
  uploadMod: (serverId: string, file: File, name: string) => {
    const form = new FormData();
    // The name field must come first: the server reads fields as they arrive,
    // and anything after the file part would not be seen in time.
    if (name.trim()) form.append('name', name.trim());
    form.append('file', file);
    return request<{ token: string; plan: InstallPlan }>(
      `/api/servers/${encodeURIComponent(serverId)}/mods/upload`,
      { method: 'POST', body: form },
    );
  },
  installUploadedMod: (serverId: string, token: string, acknowledge: boolean) =>
    request<{ installed: true; plan: InstallPlan; files: number }>(
      `/api/servers/${encodeURIComponent(serverId)}/mods/upload/${encodeURIComponent(token)}`,
      { ...json({ acknowledge }), method: 'POST' },
    ),

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
  reviewApp: (id: string) =>
    request<DeployReview>(`/api/catalog/${encodeURIComponent(id)}/review`),

  deploy: (body: {
    appId: string;
    name: string;
    variables: Record<string, string>;
    ports: Record<string, number>;
    extra?: ExtraParameters;
    acknowledge?: boolean;
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
