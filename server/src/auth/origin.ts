import type { FastifyRequest } from 'fastify';

/**
 * Where a request came from, for the audit log. trustProxy is on, so behind
 * Cloudflare Tunnel or a reverse proxy request.ip is the real client address
 * rather than the proxy's.
 */
export function originOf(request: FastifyRequest): { ip: string; userAgent: string | null } {
  const agent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
  };
}
