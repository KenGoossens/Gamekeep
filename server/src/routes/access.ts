import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { originOf } from '../auth/origin.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { AccessError, createAccessClient, type AccessClient } from '../access/cloudflare.js';

/**
 * The guest list for the portal itself.
 *
 * Connecting Cloudflare is owner-only: it stores a credential and chooses
 * which policy this portal is allowed to edit. Adding and removing addresses
 * is operator-level, because it is a weaker capability than the one operators
 * already have -- an address on the Access policy only lets someone reach the
 * login page, while creating a Gamekeep account lets them actually in.
 */

const SETTING_KEY = 'cloudflare-access';

interface Stored {
  accountId: string;
  policyId: string;
  token: string;
}

export function registerAccessRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env, guard } = ctx;
  const owner = { preHandler: guard.requireOwner };
  const operator = { preHandler: guard.requireOperator };

  function load(): { stored: Stored; client: AccessClient } | null {
    const raw = db.getSetting(SETTING_KEY);
    if (!raw) return null;
    const plain = decryptSecret(raw, env.SESSION_SECRET);
    if (!plain) return null;

    try {
      const stored = JSON.parse(plain) as Stored;
      if (!stored.token || !stored.accountId || !stored.policyId) return null;
      return {
        stored,
        client: createAccessClient({ token: stored.token, accountId: stored.accountId }),
      };
    } catch {
      return null;
    }
  }

  const fail = (err: unknown) =>
    err instanceof AccessError
      ? {
          status: err.code === 'unauthorized' ? 401 : err.code === 'not-found' ? 404 : 400,
          body: { error: err.code, message: err.message },
        }
      : { status: 502, body: { error: 'access-failed', message: (err as Error).message } };

  // ---- the connection: owner only ----------------------------------------
  app.get('/api/integrations/access', operator, async (request, reply) => {
    const current = load();
    if (!current) {
      return reply.send({ configured: false, canConfigure: request.user!.role === 'owner' });
    }

    try {
      const policy = await current.client.policy(current.stored.policyId);
      return reply.send({
        configured: true,
        canConfigure: request.user!.role === 'owner',
        // The account id is not a secret, but the token is never returned.
        accountId: current.stored.accountId,
        policy,
      });
    } catch (err) {
      const f = fail(err);
      return reply.code(f.status).send({ configured: true, ...f.body });
    }
  });

  /**
   * Lists the policies on an account so the owner can pick one, using a token
   * supplied in the request rather than a stored one: this runs before there
   * is anything stored.
   */
  app.post<{ Body: { token?: string; accountId?: string } }>(
    '/api/integrations/access/policies',
    owner,
    async (request, reply) => {
      const token = (request.body?.token ?? '').trim() || load()?.stored.token;
      const accountId = (request.body?.accountId ?? '').trim() || load()?.stored.accountId;
      if (!token || !accountId) {
        return reply.code(400).send({ error: 'missing', message: 'Give an account id and a token.' });
      }

      try {
        return reply.send({ policies: await createAccessClient({ token, accountId }).listPolicies() });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.put<{ Body: { token?: string; accountId?: string; policyId?: string } }>(
    '/api/integrations/access',
    owner,
    async (request, reply) => {
      const user = request.user!;
      const existing = load();
      // An empty token field keeps the stored one, so the form never has to
      // echo a secret back in order to change the policy.
      const token = (request.body?.token ?? '').trim() || existing?.stored.token;
      const accountId = (request.body?.accountId ?? '').trim() || existing?.stored.accountId;
      const policyId = (request.body?.policyId ?? '').trim();

      if (!token || !accountId || !policyId) {
        return reply
          .code(400)
          .send({ error: 'missing', message: 'An account id, a token and a policy are all needed.' });
      }

      try {
        // Proven before it is stored, so a bad setting never becomes a
        // failure discovered later when someone is trying to add a friend.
        const result = await createAccessClient({ token, accountId }).test(policyId);

        db.setSetting(
          SETTING_KEY,
          encryptSecret(JSON.stringify({ token, accountId, policyId }), env.SESSION_SECRET),
        );
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'integration-changed',
          result: 'success',
          detail: `Connected Cloudflare Access to policy ${result.policy.name}`,
          ...originOf(request),
        });
        return reply.send({ configured: true, detail: result.detail, policy: result.policy });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.delete('/api/integrations/access', owner, async (request, reply) => {
    const user = request.user!;
    db.deleteSetting(SETTING_KEY);
    db.audit({
      userId: user.id,
      username: user.username,
      serverId: null,
      action: 'integration-changed',
      result: 'success',
      detail: 'Disconnected Cloudflare Access',
      ...originOf(request),
    });
    return reply.send({ configured: false });
  });

  // ---- the guest list: operator level -------------------------------------
  app.post<{ Body: { email?: string } }>(
    '/api/integrations/access/emails',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const current = load();
      if (!current) return reply.code(409).send({ error: 'not-configured' });

      const email = (request.body?.email ?? '').trim();
      try {
        const policy = await current.client.addEmail(current.stored.policyId, email);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'access-granted',
          result: 'success',
          detail: `Added ${email.toLowerCase()} to Cloudflare Access policy "${policy.name}"`,
          ...originOf(request),
        });
        return reply.send({ policy });
      } catch (err) {
        const f = fail(err);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'access-granted',
          result: 'failure',
          detail: `${email}: ${(err as Error).message}`,
          ...originOf(request),
        });
        return reply.code(f.status).send(f.body);
      }
    },
  );

  app.delete<{ Params: { email: string } }>(
    '/api/integrations/access/emails/:email',
    operator,
    async (request, reply) => {
      const user = request.user!;
      const current = load();
      if (!current) return reply.code(409).send({ error: 'not-configured' });

      const email = decodeURIComponent(request.params.email);
      try {
        const policy = await current.client.removeEmail(current.stored.policyId, email);
        db.audit({
          userId: user.id,
          username: user.username,
          serverId: null,
          action: 'access-revoked',
          result: 'success',
          detail: `Removed ${email.toLowerCase()} from Cloudflare Access policy "${policy.name}"`,
          ...originOf(request),
        });
        return reply.send({ policy });
      } catch (err) {
        const f = fail(err);
        return reply.code(f.status).send(f.body);
      }
    },
  );
}
