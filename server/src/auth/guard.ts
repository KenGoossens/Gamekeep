import type { FastifyReply, FastifyRequest } from 'fastify';
import { canOperate, type Db, type Role, type ServerAccess } from '../db.js';
import type { Sessions } from './session.js';

/** What a user may do on one particular server. */
export type EffectiveAccess = 'owner' | 'operator' | 'member' | 'none';

export function createGuard(sessions: Sessions, db: Db) {
  /**
   * Resolves the caller or answers 401. Returning 401 rather than redirecting
   * keeps the frontend simple: any 401 means "show the login screen".
   */
  async function requireUser(request: FastifyRequest, reply: FastifyReply) {
    const user = sessions.resolve(request);
    if (!user) return reply.code(401).send({ error: 'not-authenticated' });
    request.user = user;
  }

  /**
   * As requireUser, but also refuses anyone still carrying a temporary
   * password. They can reach only /api/me, the password change and logout, so
   * a handed-out temp password cannot restart anything.
   */
  async function requireActiveUser(request: FastifyRequest, reply: FastifyReply) {
    await requireUser(request, reply);
    if (reply.sent) return;
    if (request.user?.mustChangePassword) {
      return reply.code(403).send({ error: 'password-change-required' });
    }
  }

  /**
   * Owners and operators: installing, stopping and starting game servers.
   * This is the delegated level -- full control of the servers, none of the
   * accounts.
   */
  async function requireOperator(request: FastifyRequest, reply: FastifyReply) {
    await requireActiveUser(request, reply);
    if (reply.sent) return;
    if (!canOperate(request.user!.role)) {
      return reply.code(403).send({ error: 'operator-required' });
    }
  }

  /** Owners only: everything about accounts. */
  async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
    await requireActiveUser(request, reply);
    if (reply.sent) return;
    if (request.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'owner-required' });
    }
  }

  /**
   * What this user may do on this one server.
   *
   * The global role is the rule; a per-server override is the exception. An
   * owner is never overridable -- whoever owns the machine owns every server
   * on it, and a row claiming otherwise would only be confusing to honour.
   */
  function accessFor(user: { id: string; role: Role }, serverId: string): EffectiveAccess {
    if (user.role === 'owner') return 'owner';
    const override: ServerAccess | null = db.serverRoleOverride(serverId, user.id);
    return override ?? (user.role as EffectiveAccess);
  }

  /**
   * Operator on this server, whether by global role or by exception. Answers
   * 404 rather than 403 for someone the server is hidden from: telling them
   * it exists is exactly what 'none' is meant to stop.
   */
  async function requireServerOperator(request: FastifyRequest, reply: FastifyReply) {
    await requireActiveUser(request, reply);
    if (reply.sent) return;
    // Typed loosely on purpose: every server route carries :id, and a guard
    // that demanded the exact generic would fight each route's own Body type.
    const serverId = String((request.params as { id?: string }).id ?? '');
    const access = accessFor(request.user!, serverId);
    if (access === 'none') return reply.code(404).send({ error: 'unknown-server' });
    if (access === 'member') return reply.code(403).send({ error: 'operator-required' });
  }

  /** May see and restart this server; the level every guest starts at. */
  async function requireServerMember(request: FastifyRequest, reply: FastifyReply) {
    await requireActiveUser(request, reply);
    if (reply.sent) return;
    const serverId = String((request.params as { id?: string }).id ?? '');
    if (accessFor(request.user!, serverId) === 'none') {
      return reply.code(404).send({ error: 'unknown-server' });
    }
  }

  return {
    requireUser,
    requireActiveUser,
    requireOperator,
    requireOwner,
    requireServerOperator,
    requireServerMember,
    accessFor,
  };
}

export type Guard = ReturnType<typeof createGuard>;
