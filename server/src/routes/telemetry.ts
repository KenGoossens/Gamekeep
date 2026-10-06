import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { gameByQueryType } from '../games.js';

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
  app.get<{ Querystring: { server?: string } }>(
    '/api/issue-template',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const p = telemetry.payload();
      const games = Object.entries(p.games)
        .map(([name, count]) => `${name} ×${count}`)
        .join(', ');

      /*
       * With ?server=<id> the template carries that server's sanitised
       * context — the game, the container's state, the build comparison —
       * which is exactly what a useful bug report opens with. Still no
       * names, addresses or log contents: the reporter adds what they
       * choose to, and sees all of it in GitHub's form before submitting.
       */
      const serverLines: string[] = [];
      const server = request.query.server ? ctx.registry.get(request.query.server) : undefined;
      if (request.query.server && (!server || guard.accessFor(request.user!, request.query.server) === 'none')) {
        return reply.code(404).send({ error: 'unknown-server' });
      }
      if (server) {
        const status = await ctx.docker.getStatus(server);
        const game = gameByQueryType(server.query?.type);
        serverLines.push(
          `- Game: ${game?.label ?? 'not recognised by the registry'}`,
          `- Server state: ${status.state}${status.exitCode !== null ? ` (exit code ${status.exitCode})` : ''}${
            status.uptimeSeconds ? `, up ${Math.round(status.uptimeSeconds / 3600)}h` : ''
          }`,
          `- Update strategy: ${server.updateStrategy}`,
        );
        const update = ctx.updates.get(server.id);
        if (update?.latestBuild) {
          serverLines.push(
            `- Steam build: installed ${update.installedBuild}, current ${update.latestBuild}${update.updateAvailable ? ' (update available)' : ''}`,
          );
        }
      }

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
        ...serverLines,
        '',
        '<!-- Nothing above identifies you or your machine; edit freely. -->',
      ].join('\n');
      return reply.send({
        url: `https://github.com/KenGoossens/Gamekeep/issues/new?body=${encodeURIComponent(body)}`,
      });
    },
  );

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
