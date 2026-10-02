import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { encryptSecret } from '../secrets.js';
import { coveredBy, requiredForwards, UnifiError } from '../unifi.js';
import { connectSettings, gameByQueryType, missingPorts, type GamePort } from '../games.js';
import { buildProvider, listProviders } from '../router/provider.js';
import { loadRouter as loadStoredRouter, ROUTER_SETTING_KEY } from '../router/stored.js';
import { createPublicAddressLookup } from '../network/publicip.js';
import '../router/unifi-provider.js';

export function registerNetworkRoutes(app: FastifyInstance, ctx: AppContext) {
  const { registry, docker, db, env, guard } = ctx;
  const publicIp = createPublicAddressLookup();
  const owner = { preHandler: guard.requireOwner };

  /**
   * Ports the game needs that this container never published.
   *
   * Forwarding can only ever act on what a container publishes, so a port the
   * template forgot is invisible to it -- the rules look complete and
   * multiplayer still does not work. This compares against the game registry
   * instead, and is the only check here that can see an absence.
   */
  async function gaps(server: { container: string; query?: { type: string } }): Promise<{
    known: boolean;
    missing: GamePort[];
  }> {
    const game = gameByQueryType(server.query?.type);
    if (!game) return { known: false, missing: [] };

    let bindings: Record<string, unknown> = {};
    try {
      const info = await docker.docker.getContainer(server.container).inspect();
      bindings = info.HostConfig?.PortBindings ?? {};
    } catch {
      // A container that cannot be inspected is reported elsewhere; here it
      // just means we cannot say, which is not the same as "nothing missing".
      return { known: false, missing: [] };
    }

    const published = Object.entries(bindings)
      .filter(([, value]) => Array.isArray(value) && value.length > 0)
      .map(([key]) => {
        const [port, protocol] = key.split('/');
        return { port: Number(port), protocol: protocol === 'udp' ? ('udp' as const) : ('tcp' as const) };
      });

    return { known: true, missing: missingPorts(game, published) };
  }
  const operator = { preHandler: guard.requireServerOperator };

  const loadRouter = () => loadStoredRouter(db, env);

  /**
   * Where forwards should point. Without it the portal can still say which
   * ports are needed, just not to which address.
   */
  const target = () => env.LAN_ADDRESS.trim();
  const failure = (err: unknown) =>
    err instanceof UnifiError
      ? { status: err.code === 'unauthorized' ? 401 : 502, body: { error: err.code, message: err.message } }
      : { status: 500, body: { error: 'unifi-failed', message: (err as Error).message } };

  // ---- the router connection: owner only ------------------------------
  app.get('/api/integrations/router', owner, async (_request, reply) => {
    const current = loadRouter();
    return reply.send({
      providers: listProviders(),
      lanAddress: target(),
      configured: Boolean(current),
      provider: current?.stored.provider ?? null,
      // Secrets are never returned, only the harmless fields.
      config: current
        ? Object.fromEntries(
            Object.entries(current.stored.config).filter(
              ([key]) => !['apiKey', 'password', 'token', 'fingerprint'].includes(key),
            ),
          )
        : {},
    });
  });

  app.put<{ Body: { provider?: string; config?: Record<string, string> } }>(
    '/api/integrations/router',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const id = String(request.body?.provider ?? '').trim();
      const config = { ...(request.body?.config ?? {}) };

      const provider = buildProvider(id, config);
      if (!provider) {
        return reply.code(400).send({ error: 'unknown-provider', message: 'No such router type.' });
      }

      try {
        // Proven before it is stored, so a bad setting never becomes a
        // silent failure discovered later during a deploy.
        const result = await provider.test();
        if (result.fingerprint) config.fingerprint = result.fingerprint;

        db.setSetting(
          ROUTER_SETTING_KEY,
          encryptSecret(JSON.stringify({ provider: id, config }), env.SESSION_SECRET),
        );

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'integration-changed',
          result: 'success',
          detail: `Connected router via ${provider.label} (${result.detail})`,
          ...originOf(request),
        });
        return reply.send({ configured: true, provider: id, detail: result.detail });
      } catch (err) {
        const f = failure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.delete('/api/integrations/router', owner, async (request, reply) => {
    const user = request.user!;
    db.deleteSetting(ROUTER_SETTING_KEY);
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: null,
      action: 'integration-changed',
      result: 'success',
      detail: 'Disconnected the router',
      ...originOf(request),
    });
    return reply.send({ configured: false });
  });
  // ---- how to join: member level ---------------------------------------
  /*
   * The answer to "how do I get in?", in one place: address, port, and -- for
   * recognised games -- the password, world and server name read straight
   * from the container. Member level on purpose: the password here is the
   * game's door key, and the members are exactly the people it was set for.
   * Deploying a server used to leave its password visible to nobody at all.
   */
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/connect',
    { preHandler: guard.requireServerMember },
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const game = gameByQueryType(server.query?.type);
      const specs = connectSettings(game);

      let values: Record<string, string> = {};
      try {
        const info = await docker.docker.getContainer(server.container).inspect();
        const envEntries = new Map(
          (info.Config?.Env ?? []).map((entry) => {
            const index = entry.indexOf('=');
            return [entry.slice(0, index), entry.slice(index + 1)] as const;
          }),
        );
        values = Object.fromEntries(
          specs
            .map((spec) => [spec.connect!, envEntries.get(spec.key) ?? ''] as const)
            .filter(([, value]) => value !== ''),
        );
      } catch {
        // A container that cannot be inspected still has an address to show.
      }

      const forwards = await requiredForwards(docker, server).catch(() => []);
      const joinPort = forwards.find((f) => !f.sensitive)?.port ?? null;

      return reply.send({
        publicAddress: await publicIp.get(),
        lanAddress: target() || null,
        port: joinPort ? Number(joinPort) : null,
        game: game?.label ?? null,
        name: values.name ?? null,
        world: values.world ?? null,
        password: values.password ?? null,
      });
    },
  );

  // ---- per-server forwards: operator level -----------------------------
  app.get<{ Params: { id: string } }>(
    '/api/servers/:id/portforward',
    operator,
    async (request, reply) => {
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const current = loadRouter();
      const needed = await requiredForwards(docker, server);
      const unpublished = await gaps(server);
      const to = target();
      // What to actually give a friend. Looked up alongside the rules rather
      // than on its own, so the address and the ports it belongs to arrive
      // together instead of as two things to piece together.
      const publicAddress = await publicIp.get();

      if (!current) {
        // Still useful without a router: these are the rules to make by hand.
        return reply.send({
          configured: false,
          target: to,
          publicAddress,
          needed,
          rules: [],
          missing: needed,
          unpublished,
        });
      }

      try {
        const rules = await current.provider.list();
        const missing = needed.filter((n) => !rules.some((r) => coveredBy(r, n, to)));
        const mine = rules.filter((r) => r.fwd === to && needed.some((n) => coveredBy(r, n, to)));
        return reply.send({
          configured: true,
          target: to,
          publicAddress,
          needed,
          rules: mine,
          missing,
          unpublished,
        });
      } catch (err) {
        const f = failure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { ports?: string[] } }>(
    '/api/servers/:id/portforward',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const current = loadRouter();
      if (!current) return reply.code(409).send({ error: 'not-configured' });
      const to = target();
      if (!to) {
        return reply
          .code(409)
          .send({ error: 'no-lan-address', message: 'Set LAN_ADDRESS so forwards have a destination.' });
      }

      try {
        const client = current.provider;
        const [needed, existing] = await Promise.all([
          requiredForwards(docker, server),
          client.list(),
        ]);

        const requested = request.body?.ports;
        if (!Array.isArray(requested) || requested.length === 0) {
          return reply.code(400).send({ error: 'no-ports', message: 'Choose which ports to open.' });
        }

        // Only ports this server actually publishes, and only ones not already
        // covered -- a client cannot name an arbitrary port to open.
        const missing = needed.filter(
          (n) => requested.includes(n.port) && !existing.some((r) => coveredBy(r, n, to)),
        );
        const created = [];
        for (const need of missing) created.push(await client.create(to, need));

        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'portforward-opened',
          result: 'success',
          detail:
            created.length > 0
              ? `Opened ${created.map((r) => `${r.proto} ${r.dstPort}`).join(', ')} to ${to}`
              : 'Nothing to open; every port was already forwarded',
          ...originOf(request),
        });
        return reply.send({ created, alreadyPresent: needed.length - missing.length });
      } catch (err) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'portforward-opened',
          result: 'failure',
          detail: (err as Error).message,
          ...originOf(request),
        });
        const f = failure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.delete<{ Params: { id: string; ruleId: string } }>(
    '/api/servers/:id/portforward/:ruleId',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const server = registry.get(request.params.id);
      if (!server) return reply.code(404).send({ error: 'unknown-server' });

      const current = loadRouter();
      if (!current) return reply.code(409).send({ error: 'not-configured' });

      try {
        await current.provider.remove(request.params.ruleId);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: server.id,
          action: 'portforward-closed',
          result: 'success',
          detail: `Removed rule ${request.params.ruleId}`,
          ...originOf(request),
        });
        return reply.send({ ok: true });
      } catch (err) {
        const f = failure(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );
}
