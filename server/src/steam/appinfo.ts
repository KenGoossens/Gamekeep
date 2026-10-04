/**
 * What Steam knows about one app, read the way SteamCMD reads it.
 *
 * Every Steam app carries its own launch configuration -- which executable,
 * which arguments, for which OS -- in the app info that SteamCMD's
 * `app_info_print` would show. That is the missing half of a generic deploy:
 * SteamCMD can download any app id, but only the app info says how to *start*
 * what it downloaded. api.steamcmd.net serves that same app info as JSON, so
 * nothing here needs a Steam login or a key.
 *
 * The launch entry is a proposal, never gospel: publishers write them for the
 * Steam client, so a headless server sometimes gets the xterm variant or a
 * missing -nogui. The operator sees the command and can correct it before
 * anything is created.
 */

import { ModSourceError } from '../mods/sources.js';

const INFO_URL = 'https://api.steamcmd.net/v1/info/';

export interface SteamLaunch {
  executable: string;
  arguments: string;
  os: 'linux' | 'windows' | 'macos' | 'any';
  description: string;
}

export interface SteamAppInfo {
  appId: number;
  name: string;
  /** Steam's own app type: Game, Tool, Application... Servers are usually tools. */
  type: string;
  osList: string[];
  launches: SteamLaunch[];
  /** Whether anything here can run on Linux at all. */
  linux: boolean;
  /** Rough size of the Linux depots, for expectation-setting only. */
  sizeMB: number | null;
}

interface RawLaunch {
  executable?: string;
  arguments?: string;
  description?: string;
  config?: { oslist?: string };
}

function osOf(raw: RawLaunch): SteamLaunch['os'] {
  const os = raw.config?.oslist ?? '';
  if (/linux/i.test(os)) return 'linux';
  if (/windows/i.test(os)) return 'windows';
  if (/macos/i.test(os)) return 'macos';
  return 'any';
}

export async function inspectSteamApp(appId: number): Promise<SteamAppInfo> {
  if (!Number.isInteger(appId) || appId <= 0 || appId > 99_999_999) {
    throw new ModSourceError('That is not a Steam app id.', 'bad-reference');
  }

  let response: Response;
  try {
    response = await fetch(`${INFO_URL}${appId}`, {
      headers: { accept: 'application/json', 'user-agent': 'GameKeepr' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ModSourceError(
      `Could not reach the Steam app-info service: ${(err as Error).message}`,
      'unreachable',
    );
  }
  if (response.status === 404) {
    throw new ModSourceError(`Steam has no app ${appId}.`, 'not-found');
  }
  if (!response.ok) {
    throw new ModSourceError(`The app-info service answered ${response.status}.`, 'bad-response');
  }

  const payload = (await response.json()) as {
    status?: string;
    data?: Record<
      string,
      {
        common?: { name?: string; type?: string; oslist?: string };
        config?: { launch?: Record<string, RawLaunch> };
        depots?: Record<string, { maxsize?: string; config?: { oslist?: string } }>;
      }
    >;
  };
  const app = payload.data?.[String(appId)];
  if (payload.status !== 'success' || !app?.common) {
    throw new ModSourceError(
      `Steam has no usable app info for ${appId}. It may be delisted or private.`,
      'not-found',
    );
  }

  const launches: SteamLaunch[] = Object.values(app.config?.launch ?? {})
    .filter((raw) => raw.executable)
    .map((raw) => ({
      executable: String(raw.executable),
      arguments: String(raw.arguments ?? ''),
      description: String(raw.description ?? ''),
      os: osOf(raw),
    }));

  const osList = String(app.common.oslist ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // The depots whose bytes a Linux install would actually pull.
  let size = 0;
  for (const depot of Object.values(app.depots ?? {})) {
    const os = depot?.config?.oslist ?? '';
    if (depot?.maxsize && (!os || /linux/i.test(os))) size += Number(depot.maxsize) || 0;
  }

  return {
    appId,
    // Control characters stripped and length capped: this name ends up in a
    // root start script's comment header and a compose file, and a newline
    // smuggled through a third-party app-info record must never become a
    // line that executes. Supply-chain caution, not paranoia.
    name:
      String(app.common.name ?? `App ${appId}`)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 120) || `App ${appId}`,
    type: String(app.common.type ?? ''),
    osList,
    launches,
    linux:
      launches.some((l) => l.os === 'linux' || l.os === 'any') ||
      osList.some((o) => /linux/i.test(o)),
    sizeMB: size > 0 ? Math.round(size / 1048576) : null,
  };
}

/**
 * The launch line to suggest for a headless Linux server.
 *
 * Scored rather than picked blindly: publishers list several entries and the
 * first one is written for someone's desktop. Anything mentioning a display
 * (xterm, x11) loses points; anything that says nogui, headless, batchmode or
 * server gains them. The result is a suggestion the operator confirms.
 */
export function proposeCommand(info: SteamAppInfo): { command: string; warnings: string[] } {
  const warnings: string[] = [];
  const candidates = info.launches.filter((l) => l.os === 'linux' || l.os === 'any');

  if (candidates.length === 0) {
    return {
      command: '',
      warnings: [
        info.linux
          ? 'Steam lists no Linux launch command for this app, so the start command must be written by hand.'
          : 'Steam publishes no Linux build of this server, so it cannot run here without Wine — use an Unraid template that provides one instead.',
      ],
    };
  }

  const score = (l: SteamLaunch): number => {
    const text = `${l.executable} ${l.arguments} ${l.description}`.toLowerCase();
    let points = 0;
    // A lookbehind, not a lookahead: "-nogui" is the headless flag and must
    // never be punished for containing the letters g-u-i.
    if (/xterm|x11|(?<!no)gui/.test(text)) points -= 10;
    if (/nogui|-batchmode|headless|nographics/.test(text)) points += 5;
    if (/server/.test(text)) points += 2;
    if (l.os === 'linux') points += 1;
    return points;
  };
  const best = [...candidates].sort((a, b) => score(b) - score(a))[0]!;

  // A bare file name needs ./ to run from the install directory; Windows-style
  // separators never survive on Linux and are normalised away.
  let exe = best.executable.replace(/\\/g, '/');
  if (!exe.includes('/')) exe = `./${exe}`;
  let command = `${exe}${best.arguments ? ` ${best.arguments}` : ''}`.trim();

  if (/xterm/i.test(command)) {
    /*
     * Publishers list the xterm wrapper because the Steam client runs it in a
     * terminal window; the depot almost always ships the plain script it
     * wraps (Valheim: start_server_xterm.sh wraps start_server.sh). Headless
     * is what a container needs, so the plain name is proposed and the
     * original kept in the warning for whoever needs to compare.
     */
    warnings.push(
      `Steam's own entry was "${command}", an xterm wrapper that needs a display a container does not have; the headless variant it usually wraps is proposed instead. If the server does not start, check the game's documentation.`,
    );
    command = command.replace(/_xterm/i, '');
  } else if (/x11/i.test(command)) {
    warnings.push(
      'The suggested command mentions a display (X11), which a container does not have. Check the game’s own documentation for the headless variant.',
    );
  }
  if (candidates.length > 1) {
    warnings.push(
      `Steam lists ${candidates.length} Linux launch variants; the most headless-looking one was chosen. The others: ${candidates
        .filter((c) => c !== best)
        .map((c) => `${c.executable} ${c.arguments}`.trim())
        .join(' · ')}`,
    );
  }
  return { command, warnings };
}
