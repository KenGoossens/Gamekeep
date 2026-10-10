import type { Finding } from '../findings.js';
import type { SettingSpec } from '../games.js';
import { checkAgainstSpec, SettingsError } from '../settings.js';
import { STEAM_SERVERS } from '../steam/servers.data.js';

/**
 * The deploy preflight: every judgement about the OPERATOR'S OWN INPUT, made
 * before a container exists. It extends the template/image review with the
 * half that review cannot see — the values typed into the form — and speaks
 * the same Finding language, because an operator should not have to learn two
 * vocabularies for "this deploy has a problem".
 *
 * The lesson it encodes: a server that boots with a wrong password or an
 * unreadable name is not a working server, and finding that out from a friend
 * who cannot join is the most expensive possible way to learn it.
 */

/**
 * Holds the game-settings values an operator typed to the specs the registry
 * knows. Violations refuse (they are the operator's own input, fixable right
 * there in the form); an empty password merely warns, because an open server
 * is a choice someone may genuinely be making — but never silently.
 */
export function reviewGameSettings(
  specs: SettingSpec[],
  values: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  const connectSpecs = specs.filter((spec) => spec.connect);
  if (connectSpecs.length === 0) return findings;

  // Values are checked per spec; dual spellings (SERVER_PASS and SRV_PWD)
  // mean a connect CLASS counts as filled when any of its spellings is.
  const filled = (kind: NonNullable<SettingSpec['connect']>): boolean =>
    connectSpecs.some((spec) => spec.connect === kind && (values[spec.key] ?? '').trim() !== '');

  for (const spec of connectSpecs) {
    const value = values[spec.key];
    if (value === undefined || value.trim() === '') continue;
    try {
      checkAgainstSpec(spec, value);
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      findings.push({
        id: `setting-${spec.key.toLowerCase()}`,
        label: spec.label,
        state: 'fail',
        summary: err.message,
        detail: spec.help,
      });
    }
  }

  const hasPasswordSpec = connectSpecs.some((spec) => spec.connect === 'password');
  if (hasPasswordSpec && !filled('password')) {
    findings.push({
      id: 'no-password',
      label: 'Server password',
      state: 'warn',
      summary: 'No server password set — anyone who finds the address can join.',
      detail:
        'Fine for a LAN party; risky for a server with forwarded ports. It can be set later on the Settings tab, which recreates the container.',
    });
  }

  const hasAdminSpec = connectSpecs.some((spec) => spec.connect === 'admin');
  if (hasAdminSpec && !filled('admin')) {
    findings.push({
      id: 'no-admin-password',
      label: 'Admin password',
      state: 'warn',
      summary: 'No admin password set — in-game admin commands will be unavailable or open.',
      detail: 'This game has a separate administrator credential. Set it now or later on the Settings tab.',
    });
  }

  return findings;
}

const anonByAppid = new Map(
  STEAM_SERVERS.filter((s) => s.anon !== undefined).map((s) => [s.appid, s.anon!]),
);

/**
 * Whether SteamCMD will hand this app to an anonymous login, per the Valve
 * wiki's dedicated-servers list (baked in at build time; see servers.data.ts).
 *
 * A "no" warns rather than refuses: the source is a community wiki, and a
 * stale row must never block a deploy that would have worked — but the
 * operator deploys knowing the first download may demand an account, instead
 * of discovering it in the logs an hour later.
 */
/**
 * The Steam path's whole preflight, in one place: the Linux build and the
 * anonymous-download question, as Findings. The deploy route and the
 * validation runner both call this, so "the same refusal a deploy would get"
 * is true by construction rather than by copy.
 */
export function steamPreflight(
  info: { name: string; appId: number; linux: boolean; windows: boolean },
  hasCredentials: boolean,
): Finding[] {
  const findings: Finding[] = [];
  if (!info.linux && info.windows) {
    findings.push({
      id: 'no-linux',
      label: 'Linux build',
      state: 'warn',
      summary: `Steam publishes no Linux build of ${info.name} — GameKeepr will run the Windows server through Wine.`,
      detail:
        'The container downloads the Windows files and starts the .exe under Wine on a virtual display, the same way the Unraid community runs these servers. It works well for many games, but it is not native: a bit more RAM, and the odd game needs Wine settings of its own.',
    });
  } else if (!info.linux) {
    findings.push({
      id: 'no-linux',
      label: 'Linux build',
      state: 'fail',
      summary: `Steam publishes neither a Linux nor a Windows build of ${info.name}, so it cannot run here.`,
      detail: 'Only a macOS build (or none at all) is on record for this app.',
    });
  }
  findings.push(reviewSteamAnonymous(info.appId, hasCredentials));
  return findings;
}

export function reviewSteamAnonymous(appId: number, hasCredentials: boolean): Finding {
  if (hasCredentials) {
    return {
      id: 'steam-login',
      label: 'Steam download',
      state: 'pass',
      summary: 'A Steam account is set for the download.',
    };
  }
  const anon = anonByAppid.get(appId);
  if (anon === true) {
    return {
      id: 'steam-login',
      label: 'Steam download',
      state: 'pass',
      summary: 'This app downloads with anonymous login.',
    };
  }
  if (anon === false) {
    return {
      id: 'steam-login',
      label: 'Steam download',
      state: 'warn',
      summary: 'This app likely refuses anonymous downloads — the first start would fail without a Steam account.',
      detail:
        "Per Valve's dedicated-servers list. Set a Steam account on this deploy, or acknowledge to try anonymously anyway (the list is community-maintained and can be stale).",
    };
  }
  return {
    id: 'steam-login',
    label: 'Steam download',
    state: 'unknown',
    summary: 'Whether this app allows anonymous downloads is not on record; the first start will tell.',
    detail: 'If the first boot logs a licence or subscription error, set a Steam account on the deploy and start it again.',
  };
}
