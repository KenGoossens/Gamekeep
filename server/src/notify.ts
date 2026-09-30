/**
 * Telling someone when something went wrong.
 *
 * This portal exists because its owner is away, and until now nothing acted
 * on that. A friend could restart a server, watch it come back as
 * "unconfirmed" -- container alive, game silent -- and the only record was an
 * audit row nobody would read until somebody happened to look.
 *
 * Deliberately narrow. It reports the things you would want to be interrupted
 * for and stays quiet about the rest: a successful restart is the system
 * working, and a channel that pings for those is a channel people mute.
 */

import type { ServerConfig } from './config.js';
import { gameByQueryType } from './games.js';

export type EventKind =
  | 'restarted'
  | 'started'
  | 'stopped'
  | 'restart-unconfirmed'
  | 'restart-failed'
  | 'server-down'
  | 'server-recovered'
  | 'deployed'
  | 'mod-installed'
  | 'access-granted';

/**
 * Events the portal itself caused, as opposed to ones it merely noticed.
 *
 * The difference decides whether repeats are collapsed. Two restarts five
 * minutes apart are two things someone did and both are worth saying; two
 * "server is down" a minute apart are one fact reported twice.
 */
const DELIBERATE: EventKind[] = [
  'restarted',
  'started',
  'stopped',
  'restart-unconfirmed',
  'restart-failed',
  'deployed',
  'mod-installed',
  'access-granted',
];

/**
 * Enough to recognise the game at a glance.
 *
 * The artwork has to be somewhere Discord can fetch it, which rules out this
 * portal's own /artwork route: that sits behind Cloudflare Access, and Discord
 * cannot sign in. Both of the sources the portal already uses -- Steam's CDN
 * and jsDelivr -- are public, so the notification links straight to those.
 */
export interface NotifyServer {
  name: string;
  id?: string;
  steamAppId?: number | null;
  iconUrl?: string | null;
}

/**
 * The bits of a server a notification needs to show the game, not just name it.
 *
 * One builder instead of the same four lines repeated at each call site, so a
 * new kind of notification cannot quietly ship without artwork.
 */
export function notifyServer(server: ServerConfig): NotifyServer {
  return {
    name: server.displayName,
    id: server.id,
    // A per-server id wins, but hardly anyone sets one: the game registry
    // knows the id for every game the portal recognises.
    steamAppId: server.steamAppId ?? gameByQueryType(server.query?.type)?.steamAppId,
    iconUrl: server.iconUrl,
  };
}

/**
 * Who did it.
 *
 * Name and role, and deliberately not the address the audit log records: this
 * goes to a channel the other friends can read, and where someone lives is
 * not something to publish to them. That detail stays where only the owner
 * sees it.
 */
export interface NotifyActor {
  username: string;
  role?: string;
}

export interface NotifyEvent {
  kind: EventKind;
  server?: NotifyServer;
  actor?: NotifyActor;
  detail?: string;
}

export interface NotifyConfig {
  discordWebhook?: string;
  /** Kinds the operator chose to hear about. Empty means the default set. */
  events?: string[];
  /** Bumped when new kinds are added, so they are offered once. */
  version?: number;
}

/** What is worth interrupting someone for, when nothing has been chosen. */
export const DEFAULT_EVENTS: EventKind[] = [
  'restarted',
  'started',
  'stopped',
  'restart-unconfirmed',
  'restart-failed',
  'server-down',
  'server-recovered',
];

export const ALL_EVENTS: Array<{ kind: EventKind; label: string }> = [
  { kind: 'restarted', label: 'A server was restarted' },
  { kind: 'started', label: 'A server was started' },
  { kind: 'stopped', label: 'A server was stopped' },
  { kind: 'restart-unconfirmed', label: 'A restart came back but the game stayed silent' },
  { kind: 'restart-failed', label: 'A restart failed outright' },
  { kind: 'server-down', label: 'A server stopped without anyone asking' },
  { kind: 'server-recovered', label: 'A server that was down came back' },
  { kind: 'deployed', label: 'A new server was deployed' },
  { kind: 'mod-installed', label: 'A mod was installed' },
  { kind: 'access-granted', label: 'Someone was given access to the portal' },
];

/** Colour and wording per event, so a glance at the channel is enough. */
const SHAPE: Record<EventKind, { title: string; colour: number }> = {
  restarted: { title: 'Server restarted', colour: 0x4ade80 },
  started: { title: 'Server started', colour: 0x4ade80 },
  stopped: { title: 'Server stopped', colour: 0x9aa5c4 },
  'restart-unconfirmed': { title: 'Restart unconfirmed', colour: 0xfbbf24 },
  'restart-failed': { title: 'Restart failed', colour: 0xf87171 },
  'server-down': { title: 'Server went down', colour: 0xf87171 },
  'server-recovered': { title: 'Server is back', colour: 0x4ade80 },
  deployed: { title: 'Server deployed', colour: 0x7c6cf2 },
  'mod-installed': { title: 'Mod installed', colour: 0x7c6cf2 },
  'access-granted': { title: 'Access granted', colour: 0x49c9f7 },
};

/**
 * The same thing is not said twice within this window.
 *
 * A server stuck in a restart loop would otherwise produce a message every
 * thirty seconds, and the tenth one tells you nothing the first did not.
 */
const QUIET_MS = 10 * 60_000;

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png';
/*
 * The fallback banner, at the same 616x353 as a Steam capsule.
 *
 * Discord sizes an embed to its contents, so one carrying a picture came out
 * full width while one without shrank to fit its text -- a channel of them
 * looked ragged. Every embed carries an image of the same shape now, so they
 * are all the same size and the colour alone says what happened.
 *
 * Served from jsDelivr rather than from this portal: Discord fetches the image
 * itself, and it cannot get past Cloudflare Access.
 */
const BANNER =
  'https://cdn.jsdelivr.net/gh/KenGoossens/Gamekeep@main/web/public/notification-banner.png';

/** A banner the width of the embed, plus the game logo when Steam has one. */
function artworkFor(server: NotifyServer | undefined): {
  image?: { url: string };
  thumbnail?: { url: string };
} {
  if (server?.steamAppId) {
    return {
      image: { url: `${STEAM_CDN}/${server.steamAppId}/capsule_616x353.jpg` },
      thumbnail: { url: `${STEAM_CDN}/${server.steamAppId}/logo.png` },
    };
  }

  // Not on Steam, or not about a server at all: the house banner holds the
  // embed to the same size, and the tile icon still identifies the game.
  const icon =
    server?.iconUrl ?? (server?.id ? `${ICON_CDN}/${encodeURIComponent(server.id)}.png` : null);
  return { image: { url: BANNER }, ...(icon ? { thumbnail: { url: icon } } : {}) };
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

function fieldsFor(event: NotifyEvent): Field[] {
  const fields: Field[] = [];
  if (event.server) fields.push({ name: 'Server', value: event.server.name, inline: true });

  if (event.actor) {
    fields.push({
      name: 'Triggered by',
      value: event.actor.role ? `${event.actor.username} (${event.actor.role})` : event.actor.username,
      inline: true,
    });
  } else if (event.kind === 'server-down') {
    // Said outright rather than left blank: "nobody" is the whole point of
    // this particular message.
    fields.push({ name: 'Triggered by', value: 'nobody — it stopped on its own', inline: true });
  }

  return fields;
}

export function createNotifier(options: {
  publicUrl: string;
  readConfig: () => NotifyConfig;
  onError: (message: string) => void;
}) {
  const lastSent = new Map<string, number>();

  async function toDiscord(webhook: string, event: NotifyEvent): Promise<void> {
    const shape = SHAPE[event.kind];
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        username: 'GameKeepr',
        embeds: [
          {
            title: shape.title,
            description: event.detail,
            color: shape.colour,
            // The title links to the portal, so the message is one click from
            // the thing it is about.
            url: options.publicUrl,
            fields: fieldsFor(event),
            ...artworkFor(event.server),
            footer: { text: 'GameKeepr' },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    // Discord answers 204 on success and says why on anything else.
    if (!response.ok) {
      throw new Error(`Discord answered ${response.status}`);
    }
  }

  /**
   * Fire and forget. A notification that fails must never take an action with
   * it: the restart already happened, and the person waiting on it does not
   * care that a webhook was unreachable.
   */
  function send(event: NotifyEvent): void {
    const config = options.readConfig();
    if (!config.discordWebhook) return;

    const wanted = config.events?.length ? config.events : DEFAULT_EVENTS;
    if (!wanted.includes(event.kind)) return;

    /*
     * Only what the portal noticed is collapsed, never what someone did.
     * Applying the quiet window to deliberate actions would mean a second
     * restart within ten minutes simply never being mentioned -- which is
     * exactly the case where someone is retrying because the first did not
     * take, and the moment you most want to hear about it.
     */
    if (!DELIBERATE.includes(event.kind)) {
      const key = `${event.kind}:${event.server?.id ?? event.server?.name ?? ''}`;
      const now = Date.now();
      if (now - (lastSent.get(key) ?? 0) < QUIET_MS) return;
      lastSent.set(key, now);
    }

    void toDiscord(config.discordWebhook, event).catch((err: Error) =>
      options.onError(`notification failed: ${err.message}`),
    );
  }

  /**
   * Proves a webhook before it is stored.
   *
   * Sent as one of the caller's own servers when there is one, because a test
   * message with a made-up name carries no artwork -- and then it fails to
   * test the half of this most likely to be wrong.
   */
  async function test(webhook: string, sample?: NotifyServer): Promise<void> {
    await toDiscord(webhook, {
      kind: 'server-recovered',
      server: sample ?? { name: 'GameKeepr' },
      actor: { username: 'this is a test', role: 'nobody restarted anything' },
      detail: 'Notifications are working. A real message will look like this one.',
    });
  }

  return { send, test };
}

export type Notifier = ReturnType<typeof createNotifier>;
