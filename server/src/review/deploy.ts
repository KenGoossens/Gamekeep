import type { CatalogApp, ParsedTemplate, TemplateField } from '../catalog.js';
import type { Finding } from '../findings.js';
import { describeImage, RegistryError, type ImageFacts } from './registry.js';

/**
 * What an operator should know before a game server is created.
 *
 * Deploying a container is a bigger act than installing a mod -- it is a new
 * process on this host with whatever the template asked for -- and until now
 * the portal simply did it. The hardening was already there (ExtraParams
 * dropped, privileged refused, host paths replaced), it was just invisible, so
 * an operator had no way to tell a tame template from one that had to be
 * defanged. This turns that into a report.
 *
 * Nothing here says an image is safe. It says what the template asked for,
 * what was refused, and what the registry says the image is.
 */

/*
 * Host paths that say this is not an ordinary game server.
 *
 * Deliberately short. The deploy path ignores template host paths entirely and
 * substitutes a directory of its own, so none of these can actually take
 * effect -- but a template asking for the Docker socket or /boot is telling
 * you something about what it expects to be able to do, and it will not work
 * once that is taken away. Refusing is more honest than deploying something
 * quietly lobotomised.
 *
 * What is NOT here matters as much: /mnt/user/appdata is where container data
 * is supposed to live, and nearly every game server template names it.
 */
const FORBIDDEN_PATHS = [
  '/var/run/docker.sock',
  '/var/run/',
  '/boot',
  '/etc',
  '/proc',
  '/sys',
  '/root',
];

/** Ports that expose administration rather than gameplay. */
const ADMIN_PORTS: Record<string, string> = {
  '22': 'SSH',
  '25575': 'Minecraft RCON',
  '27015': 'Source RCON (also a game port for some titles)',
  '8080': 'web interface',
  '8443': 'web interface',
  '8222': 'web console',
  '9090': 'web interface',
  '3000': 'web interface',
  '5900': 'VNC',
  '3389': 'RDP',
};

/** Registries whose images this portal is willing to treat as ordinary. */
const KNOWN_REGISTRIES = ['ghcr.io', 'registry-1.docker.io', 'lscr.io', 'docker.io', 'quay.io'];

/** An image untouched for this long has unpatched base packages by definition. */
const STALE_DAYS = 550;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function pathFields(fields: TemplateField[]): TemplateField[] {
  return fields.filter((f) => f.type === 'Path');
}

/**
 * The template's own demands. This runs against the catalogue entry alone, so
 * it costs nothing and can be shown the moment an operator picks an app.
 */
export function reviewTemplate(
  app: Pick<CatalogApp, 'name' | 'publisher'>,
  template: ParsedTemplate,
  /** Asked rather than assumed: a row claiming trust it never checked is worse than no row. */
  isTrusted: (repository: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];

  const trusted = isTrusted(template.repository);
  findings.push({
    id: 'publisher',
    label: 'Publisher',
    state: trusted ? 'pass' : 'fail',
    summary: trusted
      ? `${app.publisher}, on this portal's trusted list.`
      : `${app.publisher} is not on this portal's trusted list.`,
    detail: 'TRUSTED_PUBLISHERS in .env decides who may be deployed from the catalogue.',
  });

  // ---- the things that refuse outright -----------------------------------
  if (template.privileged) {
    findings.push({
      id: 'privileged',
      label: 'Privileged',
      state: 'fail',
      summary: 'This template asks to run privileged.',
      detail:
        'A privileged container is effectively root on the Unraid host. GameKeepr will not deploy it, whatever the app.',
    });
  } else {
    findings.push({
      id: 'privileged',
      label: 'Privileged',
      state: 'pass',
      summary: 'Runs unprivileged.',
    });
  }

  const devices = template.fields.filter((f) => f.type === 'Device');
  if (devices.length > 0) {
    findings.push({
      id: 'devices',
      label: 'Host devices',
      state: 'fail',
      summary: `Asks for ${devices.length} host device(s): ${devices.map((d) => d.name).join(', ')}.`,
      detail: 'Passing a host device into a game server is refused.',
    });
  }

  const dangerous = pathFields(template.fields).filter((f) =>
    FORBIDDEN_PATHS.some((p) => (f.value ?? '').startsWith(p)),
  );
  if (dangerous.length > 0) {
    findings.push({
      id: 'host-paths',
      label: 'Host paths',
      state: 'fail',
      summary: `Asks to mount ${dangerous.map((d) => d.value).join(', ')}.`,
      detail:
        'These give a container control over the host or over other containers. Refused rather than remapped.',
    });
  }

  // ---- the things that are dropped, and worth saying so ------------------
  const paths = pathFields(template.fields);
  if (paths.length > 0) {
    findings.push({
      id: 'paths-replaced',
      label: 'Storage',
      state: 'pass',
      summary: `${paths.length} host path(s) replaced with a directory GameKeepr chooses.`,
      detail:
        'The template names its own host paths; those are ignored, and everything lands under this portal’s game server directory instead.',
    });
  }

  if (template.network === 'host') {
    findings.push({
      id: 'network',
      label: 'Network',
      state: 'warn',
      summary: 'The template wants host networking.',
      detail:
        'Every port the container opens is then open on the Unraid host directly, with no mapping in between. It will be deployed on a bridge network instead, which usually works; if the game refuses to start, this is why.',
    });
  } else {
    findings.push({
      id: 'network',
      label: 'Network',
      state: 'pass',
      summary: `Bridge network (${template.network || 'bridge'}).`,
    });
  }

  // ---- ports -------------------------------------------------------------
  const ports = template.fields.filter((f) => f.type === 'Port');
  const admin = ports.filter((p) => ADMIN_PORTS[String(p.value ?? '').trim()]);
  if (admin.length > 0) {
    findings.push({
      id: 'admin-ports',
      label: 'Administrative ports',
      state: 'warn',
      summary: admin
        .map((p) => `${p.value} (${ADMIN_PORTS[String(p.value).trim()]})`)
        .join(', '),
      detail:
        'These are not gameplay ports. They will be published on your LAN; do not forward them to the internet without knowing exactly what they do.',
    });
  } else if (ports.length > 0) {
    findings.push({
      id: 'admin-ports',
      label: 'Ports',
      state: 'pass',
      summary: `${ports.length} port(s), none of them administrative.`,
    });
  }

  // ---- credentials in the template ---------------------------------------
  const secrets = template.fields.filter(
    (f) =>
      f.type === 'Variable' &&
      /pass|secret|token|key|rcon/i.test(f.name) &&
      String(f.value ?? '').trim() !== '',
  );
  if (secrets.length > 0) {
    findings.push({
      id: 'default-secrets',
      label: 'Default credentials',
      state: 'warn',
      summary: `${secrets.map((s) => s.name).join(', ')} ships with a value already filled in.`,
      detail: 'A default password is a published password. Change it before anyone can reach the server.',
    });
  }

  return findings;
}

/**
 * What the registry says the image is. Kept separate from the template review
 * because it needs the network, and a registry that is down must not stop an
 * operator seeing everything else.
 */
export async function reviewImage(
  image: string,
): Promise<{ findings: Finding[]; facts: ImageFacts | null }> {
  let facts: ImageFacts;
  try {
    facts = await describeImage(image);
  } catch (err) {
    return {
      facts: null,
      findings: [
        {
          id: 'image',
          label: 'Image',
          state: 'unknown',
          summary:
            err instanceof RegistryError ? err.message : `Could not be looked up: ${(err as Error).message}`,
          detail: 'Nothing is known about this image beyond its name.',
        },
      ],
    };
  }

  const findings: Finding[] = [];
  const registry = facts.reference.registry;

  findings.push(
    KNOWN_REGISTRIES.includes(registry)
      ? { id: 'registry', label: 'Registry', state: 'pass', summary: registry }
      : {
          id: 'registry',
          label: 'Registry',
          state: 'warn',
          summary: `Served from ${registry}, which this portal does not recognise.`,
        },
  );

  findings.push({
    id: 'digest',
    label: 'Image identity',
    state: facts.digest ? 'pass' : 'unknown',
    summary: facts.digest
      ? `Tag "${facts.reference.reference}" currently resolves to ${facts.digest.slice(0, 19)}…`
      : 'The registry did not report a digest.',
    detail: facts.digest
      ? 'Recorded on deploy, so the audit log says which image actually ran — a tag can be moved later, a digest cannot.'
      : undefined,
  });

  // The closest honest answer to "is this vulnerable": there is no CVE feed
  // for a game server image, but an image nobody has rebuilt in years is
  // carrying whatever its base layer shipped with.
  if (facts.createdAt) {
    const age = daysSince(facts.createdAt);
    findings.push({
      id: 'freshness',
      label: 'Last built',
      state: age > STALE_DAYS ? 'warn' : 'pass',
      summary: `${facts.createdAt.slice(0, 10)} (${age} days ago).`,
      detail:
        age > STALE_DAYS
          ? 'Its base layer has not been rebuilt since, so any operating system patch published since then is missing.'
          : undefined,
    });
  } else {
    findings.push({
      id: 'freshness',
      label: 'Last built',
      state: 'unknown',
      summary: 'The image config gave no build date.',
    });
  }

  const user = (facts.user ?? '').trim();
  findings.push({
    id: 'image-user',
    label: 'Runs as',
    state: user === '' || user === '0' || user === 'root' ? 'warn' : 'pass',
    summary: user === '' || user === '0' || user === 'root' ? 'root inside the container' : user,
    detail:
      user === '' || user === '0' || user === 'root'
        ? 'Common for game server images, which drop privileges themselves at start-up. It is not privileged on the host, but a flaw in the game is a root flaw inside this container.'
        : undefined,
  });

  if (facts.os && facts.architecture && (facts.os !== 'linux' || facts.architecture !== 'amd64')) {
    findings.push({
      id: 'platform',
      label: 'Platform',
      state: 'warn',
      summary: `Built for ${facts.os}/${facts.architecture}.`,
      detail: 'That is not this host’s platform, so it may not start at all.',
    });
  }

  return { findings, facts };
}
