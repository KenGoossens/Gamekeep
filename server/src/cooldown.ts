import type { ServerConfig } from './config.js';
import type { Db } from './db.js';

export interface CooldownState {
  /** Seconds until the next restart is allowed; 0 when ready. */
  remainingSeconds: number;
  lastRestartAt: number | null;
}

/**
 * The cooldown is the single most important guardrail in this app. A game
 * server can take two minutes to boot, during which it looks "down" to anyone
 * watching -- without a cooldown, four more restarts land while it is still
 * starting and it never comes up.
 *
 * State is derived from the audit log rather than held in memory, so
 * redeploying Gamekeep does not hand everyone a fresh restart budget.
 */
export function createCooldown(db: Db) {
  function check(server: ServerConfig): CooldownState {
    const lastRestartAt = db.lastSuccessfulActionAt(server.id);
    if (lastRestartAt === null || server.cooldownSeconds === 0) {
      return { remainingSeconds: 0, lastRestartAt };
    }
    const elapsed = (Date.now() - lastRestartAt) / 1000;
    const remaining = Math.ceil(server.cooldownSeconds - elapsed);
    return { remainingSeconds: remaining > 0 ? remaining : 0, lastRestartAt };
  }

  return { check };
}

export type Cooldown = ReturnType<typeof createCooldown>;
