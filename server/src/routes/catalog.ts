import { writeFile, mkdir } from 'node:fs/promises';
import { originOf } from '../auth/origin.js';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { DeployError, planDeployment, slugify } from '../deploy.js';
import { passes, uncertain } from '../findings.js';
import { reviewImage, reviewTemplate } from '../review/deploy.js';
import { identifyGame } from '../games.js';

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );

/**
 * Unraid describes every container with an XML template. Writing one means the
 * deployed server shows up properly in the Unraid Docker tab instead of as an
 * orphan image, and stays editable there.
 */
async function writeUnraidTemplate(
  templateDir: string,
  plan: { containerName: string; image: string; network: string; env: string[]; binds: string[]; portBindings: Record<string, Array<{ HostPort: string }>> },
  icon: string | null,
  overview: string,
): Promise<string | null> {
  const configs: string[] = [];

  for (const entry of plan.env) {
    const index = entry.indexOf('=');
    const key = entry.slice(0, index);
    const value = entry.slice(index + 1);
    configs.push(
      `  <Config Name="${escapeXml(key)}" Target="${escapeXml(key)}" Default="" Mode="" ` +
        `Type="Variable" Display="always" Required="false" Mask="false">${escapeXml(value)}</Config>`,
    );
  }
  for (const bind of plan.binds) {
    const [hostPath, containerPath] = bind.split(':');
    configs.push(
      `  <Config Name="${escapeXml(containerPath ?? '')}" Target="${escapeXml(containerPath ?? '')}" ` +
        `Default="" Mode="rw" Type="Path" Display="always" Required="true" Mask="false">${escapeXml(hostPath ?? '')}</Config>`,
    );
  }
  for (const [key, bindings] of Object.entries(plan.portBindings)) {
    const [containerPort, protocol] = key.split('/');
    for (const binding of bindings) {
      configs.push(
        `  <Config Name="Port ${escapeXml(containerPort ?? '')}" Target="${escapeXml(containerPort ?? '')}" ` +
          `Default="" Mode="${escapeXml(protocol ?? 'tcp')}" Type="Port" Display="always" ` +
          `Required="false" Mask="false">${escapeXml(binding.HostPort)}</Config>`,
      );
    }
  }

  const xml = `<?xml version="1.0"?>
<Container version="2">
  <Name>${escapeXml(plan.containerName)}</Name>
  <Repository>${escapeXml(plan.image)}</Repository>
  <Network>${escapeXml(plan.network)}</Network>
  <Privileged>false</Privileged>
  <Category>GameServers:</Category>
  <Icon>${escapeXml(icon ?? '')}</Icon>
  <Overview>${escapeXml(overview.slice(0, 1200))}</Overview>
  <ExtraParams>--restart=unless-stopped</ExtraParams>
${configs.join('\n')}
</Container>
`;

  try {
    await mkdir(templateDir, { recursive: true });
    const path = `${templateDir}/my-${plan.containerName}.xml`;
    await writeFile(path, xml, 'utf8');
    return path;
  } catch {
    // Not fatal: the container runs fine, it just will not be pre-filled in
    // the Unraid UI. Happens when the templates directory is not mounted.
    return null;
  }
}

export function registerCatalogRoutes(app: FastifyInstance, ctx: AppContext) {
  const { catalog, deployer, registry, db, guard, env, artwork } = ctx;
  const operator = { preHandler: guard.requireOperator };

  app.get<{ Querystring: { q?: string; refresh?: string } }>(
    '/api/catalog',
    operator,
    async (request, reply) => {
      try {
        const { apps, fetchedAt } = await catalog.list(request.query.refresh === '1');
        const q = (request.query.q ?? '').trim().toLowerCase();
        const matches = q
          ? apps.filter(
              (a) =>
                a.name.toLowerCase().includes(q) ||
                a.publisher.toLowerCase().includes(q) ||
                a.overview.toLowerCase().includes(q),
            )
          : apps;

        return reply.send({
          fetchedAt,
          total: apps.length,
          // Capped so a blank search does not ship hundreds of entries.
          apps: matches.slice(0, 60),
          installed: registry.list().map((s) => s.id),
        });
      } catch (err) {
        request.log.error({ err }, 'catalog fetch failed');
        return reply.code(502).send({ error: 'catalog-unavailable' });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/catalog/:id/template', operator, async (request, reply) => {
    const found = await catalog.find(decodeURIComponent(request.params.id));
    if (!found) return reply.code(404).send({ error: 'unknown-app' });

    try {
      const parsed = catalog.template(found);
      return reply.send({
        app: found,
        template: {
          ...parsed,
          // Never echo a secret back into the browser from a template default.
          fields: parsed.fields.map((f) => (f.masked ? { ...f, value: '' } : f)),
        },
        suggestedName: found.name.replace(/[^A-Za-z0-9._-]/g, ''),
      });
    } catch (err) {
      request.log.error({ err, app: found.id }, 'template fetch failed');
      return reply.code(502).send({ error: 'template-unavailable', message: (err as Error).message });
    }
  });

  /**
   * What this app asks for, before anything is pulled or created.
   *
   * The template half is local and instant; the image half is a registry
   * lookup of a few kilobytes, which is why an operator can see the digest and
   * the build date of a two-gigabyte image without committing to it.
   */
  app.get<{ Params: { id: string } }>('/api/catalog/:id/review', operator, async (request, reply) => {
    const found = await catalog.find(decodeURIComponent(request.params.id));
    if (!found) return reply.code(404).send({ error: 'unknown-app' });

    try {
      const parsed = catalog.template(found);
      const template = reviewTemplate(found, parsed, catalog.isTrusted);
      const { findings: image, facts } = await reviewImage(parsed.repository);
      const findings = [...template, ...image];

      return reply.send({
        app: found,
        findings,
        image: facts,
        deployable: passes(findings),
        needsAcknowledgement: uncertain(findings),
      });
    } catch (err) {
      request.log.error({ err, app: found.id }, 'deploy review failed');
      return reply.code(502).send({ error: 'review-failed', message: (err as Error).message });
    }
  });

  app.post<{
    Body: {
      appId?: string;
      name?: string;
      variables?: Record<string, string>;
      ports?: Record<string, number>;
      acknowledge?: boolean;
    };
  }>('/api/catalog/deploy', operator, async (request, reply) => {
    const user = request.user!;
    const body = request.body ?? {};

    const found = body.appId ? await catalog.find(body.appId) : undefined;
    if (!found) return reply.code(404).send({ error: 'unknown-app' });

    // Re-checked here rather than trusted from the earlier listing: this is the
    // request that actually creates a container.
    if (!catalog.isTrusted(found.repository)) {
      return reply.code(403).send({ error: 'publisher-not-trusted', publisher: found.publisher });
    }

    const name = String(body.name ?? found.name).trim();
    const serverId = slugify(name);
    if (registry.has(serverId)) {
      return reply.code(409).send({ error: 'server-exists', serverId });
    }

    try {
      const parsed = catalog.template(found);

      /*
       * Reviewed here as well as in the route above, for the same reason a mod
       * is re-inspected at install time: the review an operator read is for
       * them to read, not a token to be replayed back. A tag may also have
       * moved between the two calls.
       */
      const templateFindings = reviewTemplate(found, parsed, catalog.isTrusted);
      const { findings: imageFindings, facts } = await reviewImage(parsed.repository);
      const findings = [...templateFindings, ...imageFindings];

      if (!passes(findings)) {
        db.audit({
          userId: user.id,
          username: user.username,
          serverId,
          action: 'server-deployed',
          result: 'failure',
          detail: `Refused ${found.name}: ${findings
            .filter((f) => f.state === 'fail')
            .map((f) => f.summary)
            .join('; ')}`,
          ...originOf(request),
        });
        return reply.code(422).send({ error: 'refused', findings });
      }

      if (uncertain(findings) && !body.acknowledge) {
        return reply.code(428).send({ error: 'needs-acknowledgement', findings, image: facts });
      }

      const plan = planDeployment(
        found,
        parsed,
        { name, variables: body.variables ?? {}, ports: body.ports ?? {} },
        env.APPDATA_ROOT,
        env.APPDATA_HOST_ROOT,
      );

      const steps: string[] = [];
      await deployer.create(plan, (message) => {
        steps.push(message);
        request.log.info({ deploy: plan.containerName }, message);
      });

      const templatePath = await writeUnraidTemplate(
        env.UNRAID_TEMPLATE_DIR,
        plan,
        parsed.icon,
        found.overview,
      );

      // Registered in the database, not the config file: the file stays
      // read-only and remains the static, operator-controlled whitelist.
      /*
       * Recognising the game is what gives a deployed server a player count
       * and a mods tab. Without it the server works but is mute: nothing else
       * ever writes a query type, so one deployed here used to behave worse
       * than one added by hand to servers.json.
       *
       * The lowest published port is the one to ask; GameDig applies each
       * game's own query-port offset from there.
       */
      const game = identifyGame(found.name, parsed.repository);
      const ports = Object.keys(plan.portBindings)
        .map((spec) => Number(spec.split('/')[0]))
        .filter((p) => Number.isFinite(p))
        .sort((a, b) => a - b);

      const definition = {
        id: serverId,
        displayName: name,
        container: plan.containerName,
        iconUrl: parsed.icon ?? undefined,
        cooldownSeconds: 300,
        restartTimeoutSeconds: 300,
        query:
          game && ports.length > 0 && env.LAN_ADDRESS.trim()
            ? { type: game.query, host: env.LAN_ADDRESS.trim(), port: ports[0] }
            : undefined,
        notes: `Deployed from Community Applications (${found.publisher}).`,
      };
      db.addManagedServer(serverId, definition, user.id);
      registry.reload();

      void artwork
        .ensure(registry.list(), (message) => request.log.info(message))
        .catch(() => undefined);

      db.audit({
        userId: user.id,
        username: user.username,
        serverId,
        action: 'server-deployed',
        result: 'success',
        // The digest, not just the tag: a tag can be moved later, so without
        // this the log says which label was asked for and not what ran.
        detail: `Deployed ${found.name} (${plan.image}${
          facts?.digest ? ` @ ${facts.digest}` : ''
        }) as ${plan.containerName}${uncertain(findings) ? ' — deployed over warnings' : ''}`,
        ...originOf(request),
      });

      return reply.code(201).send({
        serverId,
        container: plan.containerName,
        appdataPath: plan.appdataHostPath,
        unraidTemplate: templatePath,
        steps,
      });
    } catch (err) {
      const code = err instanceof DeployError ? err.code : 'deploy-failed';
      const message = (err as Error).message;
      request.log.error({ err, app: found.id }, 'deploy failed');
      db.audit({
        userId: user.id,
        username: user.username,
        serverId: null,
        action: 'server-deployed',
        result: 'failure',
        detail: `${found.name}: ${message}`,
        ...originOf(request),
      });
      return reply.code(err instanceof DeployError ? 400 : 500).send({ error: code, message });
    }
  });

  /** Removes a portal-deployed server from the list. The container is left alone. */
  app.delete<{ Params: { id: string } }>('/api/catalog/deployed/:id', operator, async (request, reply) => {
    const user = request.user!;
    const id = request.params.id;
    const managed = db.listManagedServers().some((m) => m.id === id);
    if (!managed) return reply.code(404).send({ error: 'not-portal-managed' });

    db.removeManagedServer(id);
    registry.reload();
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: id,
      action: 'server-removed',
      result: 'success',
      detail: `Removed ${id} from the portal (the container was left running)`,
      ...originOf(request),
    });
    return reply.send({ ok: true });
  });
}
