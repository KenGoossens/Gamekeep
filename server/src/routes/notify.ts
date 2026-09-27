import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { ALL_EVENTS, DEFAULT_EVENTS, type NotifyConfig } from '../notify.js';

/**
 * Where notifications go. Owner-only: a webhook URL is a credential, and
 * anyone holding it can post into that channel as this portal.
 */
export const NOTIFY_KEY = 'notifications';

/**
 * Kinds that did not exist when earlier settings were saved.
 *
 * Their absence from a stored selection is not a decision -- nobody can
 * decline something they were never offered -- so they are added once, and
 * the config is stamped so a later, deliberate removal sticks. Without this
 * the setting quietly filters out every new event type ever added.
 */
const ADDED_IN_V2: string[] = ['restarted', 'started', 'stopped'];

export function readNotifyConfig(ctx: Pick<AppContext, 'db' | 'env'>): NotifyConfig {
  const raw = ctx.db.getSetting(NOTIFY_KEY);
  if (!raw) return {};
  const plain = decryptSecret(raw, ctx.env.SESSION_SECRET);
  if (!plain) return {};

  let config: NotifyConfig;
  try {
    config = JSON.parse(plain) as NotifyConfig;
  } catch {
    return {};
  }

  if (config.version !== 2 && config.events?.length) {
    const events = [...new Set([...config.events, ...ADDED_IN_V2])];
    config = { ...config, events, version: 2 };
    ctx.db.setSetting(NOTIFY_KEY, encryptSecret(JSON.stringify(config), ctx.env.SESSION_SECRET));
  }
  return config;
}

export function registerNotifyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env, guard, notify } = ctx;
  const owner = { preHandler: guard.requireOwner };

  app.get('/api/integrations/notifications', owner, async (_request, reply) => {
    const config = readNotifyConfig(ctx);
    return reply.send({
      // The webhook is never returned; it contains its own secret.
      configured: Boolean(config.discordWebhook),
      events: config.events?.length ? config.events : DEFAULT_EVENTS,
      available: ALL_EVENTS,
    });
  });

  app.put<{ Body: { webhook?: string; events?: string[] } }>(
    '/api/integrations/notifications',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const current = readNotifyConfig(ctx);
      // An empty field keeps the stored webhook, so changing which events you
      // want does not mean pasting the URL again.
      const webhook = (request.body?.webhook ?? '').trim() || current.discordWebhook;
      const events = Array.isArray(request.body?.events)
        ? request.body.events.filter((e) => ALL_EVENTS.some((a) => a.kind === e))
        : (current.events ?? []);

      if (!webhook) {
        return reply.code(400).send({ error: 'missing', message: 'Give a Discord webhook URL.' });
      }
      if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(webhook)) {
        return reply.code(400).send({
          error: 'bad-webhook',
          message: 'That is not a Discord webhook URL. Create one in a channel’s Integrations menu.',
        });
      }

      try {
        // Proven before it is stored, so a typo is found now rather than on
        // the night something actually breaks.
        // Sent as a real server so the test exercises the artwork too.
        const sample = ctx.registry.list()[0];
        await notify.test(
          webhook,
          sample
            ? {
                name: sample.displayName,
                id: sample.id,
                steamAppId: sample.steamAppId,
                iconUrl: sample.iconUrl,
              }
            : undefined,
        );
      } catch (err) {
        return reply.code(502).send({ error: 'unreachable', message: (err as Error).message });
      }

      db.setSetting(NOTIFY_KEY, encryptSecret(JSON.stringify({ discordWebhook: webhook, events, version: 2 }), env.SESSION_SECRET));
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: null,
        action: 'integration-changed',
        result: 'success',
        detail: `Notifications set for ${events.length || DEFAULT_EVENTS.length} event type(s)`,
        ...originOf(request),
      });
      return reply.send({ configured: true, events: events.length ? events : DEFAULT_EVENTS });
    },
  );

  app.delete('/api/integrations/notifications', owner, async (request, reply) => {
    const user = request.user!;
    db.deleteSetting(NOTIFY_KEY);
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: null,
      action: 'integration-changed',
      result: 'success',
      detail: 'Turned notifications off',
      ...originOf(request),
    });
    return reply.send({ configured: false });
  });
}
