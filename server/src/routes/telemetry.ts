import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';

/**
 * The anonymous-statistics switch and its full-transparency window: GET
 * returns the LITERAL payload the next ping would carry, because "trust us"
 * is not a privacy policy. Owner-only — opting a whole install in is the
 * owner's call and nobody else's.
 */
export function registerTelemetryRoutes(app: FastifyInstance, ctx: AppContext) {
  const { telemetry, db, guard } = ctx;
  const owner = { preHandler: guard.requireOwner };

  app.get('/api/telemetry', owner, async (_request, reply) => {
    return reply.send(telemetry.state());
  });

  /**
   * The prefilled body for a GitHub issue — the honest alternative to error
   * telemetry. Sanitised by construction (version, platform, game labels,
   * counts; never names, addresses or log contents), and the person SEES it,
   * in the GitHub form, before anything is submitted. Member-level: anyone
   * who can use the portal can report that it misbehaves.
   */
  app.get('/api/issue-template', { preHandler: guard.requireActiveUser }, async (_request, reply) => {
    const p = telemetry.payload();
    const games = Object.entries(p.games)
      .map(([name, count]) => `${name} ×${count}`)
      .join(', ');
    const body = [
      '### What happened?',
      '',
      '<!-- Describe the issue. Screenshots help. -->',
      '',
      '### Environment',
      '',
      `- GameKeepr: ${p.version}`,
      `- Platform: ${p.platform}`,
      `- Servers: ${p.servers}${games ? ` (${games})` : ''}`,
      '',
      '<!-- Nothing above identifies you or your machine; edit freely. -->',
    ].join('\n');
    return reply.send({
      url: `https://github.com/KenGoossens/Gamekeep/issues/new?body=${encodeURIComponent(body)}`,
    });
  });

  app.put<{ Body: { enabled?: boolean } }>('/api/telemetry', owner, async (request, reply) => {
    const user = request.user!;
    const enabled = request.body?.enabled === true;
    telemetry.setEnabled(enabled);
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: null,
      action: 'settings-changed',
      result: 'success',
      detail: enabled ? 'Anonymous usage statistics enabled' : 'Anonymous usage statistics disabled',
      ...originOf(request),
    });
    // An opt-in sends the first ping right away: the owner just read the
    // payload and said yes — making them wait a day to appear would be odd.
    if (enabled) void telemetry.send();
    return reply.send(telemetry.state());
  });
}
