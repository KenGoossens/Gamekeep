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

export type NotifyEvent =
  | { kind: 'restart-unconfirmed'; server: string; actor: string; detail?: string }
  | { kind: 'restart-failed'; server: string; actor: string; detail?: string }
  | { kind: 'server-down'; server: string; detail?: string }
  | { kind: 'server-recovered'; server: string }
  | { kind: 'deployed'; server: string; actor: string; detail?: string }
  | { kind: 'mod-installed'; server: string; actor: string; detail?: string }
  | { kind: 'access-granted'; actor: string; detail?: string };

export interface NotifyConfig {
  discordWebhook?: string;
  /** Kinds the operator chose to hear about. Empty means the default set. */
  events?: string[];
}

/** What is worth interrupting someone for, when nothing has been chosen. */
export const DEFAULT_EVENTS: NotifyEvent['kind'][] = [
  'restart-unconfirmed',
  'restart-failed',
  'server-down',
  'server-recovered',
];

export const ALL_EVENTS: Array<{ kind: NotifyEvent['kind']; label: string }> = [
  { kind: 'restart-unconfirmed', label: 'A restart came back but the game stayed silent' },
  { kind: 'restart-failed', label: 'A restart failed outright' },
  { kind: 'server-down', label: 'A server stopped without anyone asking' },
  { kind: 'server-recovered', label: 'A server that was down came back' },
  { kind: 'deployed', label: 'A new server was deployed' },
  { kind: 'mod-installed', label: 'A mod was installed' },
  { kind: 'access-granted', label: 'Someone was given access to the portal' },
];

/** Colour and wording per event, so a glance at the channel is enough. */
const SHAPE: Record<NotifyEvent['kind'], { title: string; colour: number }> = {
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

function describe(event: NotifyEvent): { title: string; body: string; colour: number } {
  const shape = SHAPE[event.kind];
  const parts: string[] = [];

  if ('server' in event) parts.push(`**${event.server}**`);
  if ('actor' in event && event.actor) parts.push(`by ${event.actor}`);
  if ('detail' in event && event.detail) parts.push(`\n${event.detail}`);

  return { title: shape.title, colour: shape.colour, body: parts.join(' ') || '—' };
}

export function createNotifier(options: {
  publicUrl: string;
  readConfig: () => NotifyConfig;
  onError: (message: string) => void;
}) {
  const lastSent = new Map<string, number>();

  async function toDiscord(webhook: string, event: NotifyEvent): Promise<void> {
    const { title, body, colour } = describe(event);
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        username: 'Gamekeep',
        embeds: [
          {
            title,
            description: body,
            color: colour,
            url: options.publicUrl,
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

    const key = `${event.kind}:${'server' in event ? event.server : ''}`;
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < QUIET_MS) return;
    lastSent.set(key, now);

    void toDiscord(config.discordWebhook, event).catch((err: Error) =>
      options.onError(`notification failed: ${err.message}`),
    );
  }

  /** Used by the settings form to prove a webhook before it is stored. */
  async function test(webhook: string): Promise<void> {
    await toDiscord(webhook, {
      kind: 'server-recovered',
      server: 'Gamekeep — this is a test message',
    });
  }

  return { send, test };
}

export type Notifier = ReturnType<typeof createNotifier>;
