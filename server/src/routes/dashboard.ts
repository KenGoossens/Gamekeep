import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/**
 * Everything the overview screen needs, in one request.
 *
 * Built as a single endpoint rather than letting the page fan out per server:
 * a dashboard that polls is the most frequent caller this portal has, and one
 * query against the metrics table beats a dozen round trips that each wake the
 * Docker socket. The player counts come from cache for the same reason -- an
 * unreachable game server must not stall the whole screen, which is exactly
 * when someone is looking at it.
 */

const DAY_MS = 86_400_000;

export interface DashboardServer {
  id: string;
  displayName: string;
  state: string;
  running: boolean;
  uptimeSeconds: number | null;
  health: string | null;
  /** max is null for games whose query does not report a limit. */
  players: { online: number; max: number | null; names: string[] } | null;
  cpuPercent: number | null;
  memBytes: number | null;
  memLimit: number | null;
  accent: string | null;
}

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, gameQuery, metrics, db, actions, guard } = ctx;

  app.get<{ Querystring: { window?: string } }>(
    '/api/dashboard',
    { preHandler: guard.requireActiveUser },
    async (request, reply) => {
      const user = request.user!;
      // Clamped: the window drives how much history is read, and an
      // unbounded one is a way to make the server do arbitrary work.
      const windowMs = Math.min(
        Math.max(Number(request.query.window) || 6 * 3_600_000, 15 * 60_000),
        7 * DAY_MS,
      );
      const since = Date.now() - windowMs;

      // The same visibility rule as the server list: hidden means absent,
      // from the fleet, the charts and the activity alike.
      const list = registry.list().filter((server) => guard.accessFor(user, server.id) !== 'none');
      const servers: DashboardServer[] = await Promise.all(
        list.map(async (server) => {
          const status = await docker.getStatus(server);
          const players = gameQuery.getPlayersCached(server);
          const history = metrics.history(server.id, windowMs);
          const latest = history.at(-1) ?? null;

          return {
            id: server.id,
            displayName: server.displayName,
            state: status.state,
            running: status.running,
            uptimeSeconds: status.uptimeSeconds,
            health: status.health,
            players: players
              ? {
                  online: players.online,
                  max: players.max,
                  // Names, not just a count: "2 online" tells you less than
                  // "Bart and Arek are on", and it is what makes the social
                  // side of this visible at all.
                  names: (players.names ?? []).slice(0, 12),
                }
              : null,
            // Only meaningful while the container runs; a stopped server's
            // last sample is history, not a reading.
            cpuPercent: status.running ? (latest?.cpuPercent ?? null) : null,
            memBytes: status.running ? (latest?.memBytes ?? null) : null,
            memLimit: latest?.memLimit ?? null,
            accent: server.accent ?? null,
          };
        }),
      );

      // One series per server, so the charts can be drawn without a second
      // request each.
      const series = list.map((server) => ({
        id: server.id,
        label: server.displayName,
        points: metrics.history(server.id, windowMs).map((p) => ({
          ts: p.ts,
          cpu: p.cpuPercent,
          mem: p.memBytes,
          players: p.players,
        })),
      }));

      /*
       * Restart outcomes over the window. 'unconfirmed' is kept distinct from
       * 'success' on purpose: it means the container came back but the game
       * never answered, which is the single most useful thing this screen can
       * tell someone, and folding it into either bucket would hide it.
       */
      const outcomes = db.outcomesSince(since);
      const audit = db.auditSince(since, 12);

      const jobs = list
        .map((server) => actions.activeJobFor(server.id))
        .filter((job): job is NonNullable<typeof job> => Boolean(job))
        .map((job) => ({
          serverId: job.serverId,
          phase: job.phase,
          message: job.message,
          actor: job.actorUsername,
        }));

      return reply.send({
        generatedAt: Date.now(),
        windowMs,
        servers,
        series,
        totals: {
          servers: servers.length,
          running: servers.filter((s) => s.running).length,
          players: servers.reduce((sum, s) => sum + (s.players?.online ?? 0), 0),
          capacity: servers.reduce((sum, s) => sum + (s.players?.max ?? 0), 0),
        },
        outcomes,
        activeJobs: jobs,
        // Members see who did what, but not the detail line, which can carry
        // paths and error text. The same rule the server detail page follows.
        recent: audit.slice(0, 12).map((row) => ({
          id: row.id,
          ts: row.ts,
          username: row.username,
          serverId: row.serverId,
          action: row.action,
          result: row.result,
          detail: user.role !== 'member' ? row.detail : null,
        })),
      });
    },
  );
}
