import type { FastifyReply, FastifyRequest } from 'fastify';
import { canOperate } from '../db.js';
import type { Sessions } from './session.js';

export function createGuard(sessions: Sessions) {
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

  return { requireUser, requireActiveUser, requireOperator, requireOwner };
}

export type Guard = ReturnType<typeof createGuard>;
