import { decryptSecret, encryptSecret } from '../secrets.js';
import type { Db } from '../db.js';
import type { Env } from '../config.js';

/**
 * Game Server Login Tokens, managed for the owner instead of by them.
 *
 * Every CS2 server instance must present a GSLT to register with Steam, and
 * Steam hands them out one page at a time on a website -- exactly the manual
 * step this portal exists to remove. The same tokens are also available
 * through the IGameServersService Web API with an ordinary Steam Web API key,
 * so the owner pastes that key once and the portal mints a token per match
 * server, names it after the match, and deletes it at teardown.
 *
 * The key is a credential for the owner's Steam account; it is stored like
 * every other integration secret: encrypted at rest with SESSION_SECRET and
 * never echoed back to a browser.
 */

const GSLT_KEY = 'steam-gslt';
const API = 'https://api.steampowered.com/IGameServersService';

/** CS2 and its dedicated server share this app id. */
export const CS2_APP_ID = 730;

export interface GsltToken {
  steamId: string;
  token: string;
  appId: number;
  memo: string;
  /** Steam expires tokens that have not logged in for a long while; a reset
   * revives them without changing the steamId. */
  expired: boolean;
  lastLogonAt: number | null;
}

export interface GsltStatus {
  configured: boolean;
  /** Whether the stored key still works; null when not configured. */
  ok: boolean | null;
  tokenCount: number | null;
  /** Steam bans accounts from hosting; that is worth saying out loud. */
  banned: boolean | null;
  error: string | null;
}

export class GsltError extends Error {}

interface SteamAccount {
  steamid: string;
  appid: number;
  login_token: string;
  memo?: string;
  is_deleted?: boolean;
  is_expired?: boolean;
  rt_last_logon?: number;
}

export function createGsltService(deps: Pick<Db, 'getSetting' | 'setSetting' | 'deleteSetting'>, env: Env) {
  function storedKey(): string | null {
    const raw = deps.getSetting(GSLT_KEY);
    if (!raw) return null;
    const plain = decryptSecret(raw, env.SESSION_SECRET);
    if (!plain) return null;
    try {
      const parsed = JSON.parse(plain) as { apiKey?: string };
      return typeof parsed.apiKey === 'string' && parsed.apiKey ? parsed.apiKey : null;
    } catch {
      return null;
    }
  }

  /**
   * One call shape for the whole Steam Web API: GET reads, form-POST writes.
   * Steam answers a bad key with 403 and an HTML page, not JSON, so failures
   * are translated before anyone tries to parse them.
   */
  async function call<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    key: string,
    params: Record<string, string>,
  ): Promise<T> {
    const body = new URLSearchParams({ key, ...params });
    const url =
      method === 'GET' ? `${API}/${endpoint}/v1/?${body.toString()}` : `${API}/${endpoint}/v1/`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GsltError('Steam did not answer. Check the machine’s internet connection.');
    }

    if (response.status === 401 || response.status === 403) {
      throw new GsltError('Steam refused the API key. Check it on steamcommunity.com/dev/apikey.');
    }
    if (!response.ok) {
      // Steam explains refusals in a header more often than in the body.
      const detail = response.headers.get('x-error_message');
      throw new GsltError(
        detail
          ? `Steam refused: ${detail}`
          : `Steam answered ${response.status} for ${endpoint}.`,
      );
    }

    try {
      return ((await response.json()) as { response: T }).response;
    } catch {
      throw new GsltError(`Steam sent an unreadable answer for ${endpoint}.`);
    }
  }

  async function listWith(key: string): Promise<{ tokens: GsltToken[]; banned: boolean }> {
    const data = await call<{ servers?: SteamAccount[]; is_banned?: boolean }>(
      'GET',
      'GetAccountList',
      key,
      {},
    );
    const tokens = (data.servers ?? [])
      .filter((s) => !s.is_deleted)
      .map((s) => ({
        steamId: s.steamid,
        token: s.login_token,
        appId: s.appid,
        memo: s.memo ?? '',
        expired: s.is_expired === true,
        lastLogonAt: s.rt_last_logon ? s.rt_last_logon * 1000 : null,
      }));
    return { tokens, banned: data.is_banned === true };
  }

  function requireKey(): string {
    const key = storedKey();
    if (!key) {
      throw new GsltError('No Steam Web API key is configured. Add one under Settings → Steam.');
    }
    return key;
  }

  return {
    configured: () => storedKey() !== null,

    /** Answers "does this still work" without ever revealing the key. */
    async status(): Promise<GsltStatus> {
      const key = storedKey();
      if (!key) return { configured: false, ok: null, tokenCount: null, banned: null, error: null };
      try {
        const { tokens, banned } = await listWith(key);
        return { configured: true, ok: true, tokenCount: tokens.length, banned, error: null };
      } catch (err) {
        return {
          configured: true,
          ok: false,
          tokenCount: null,
          banned: null,
          error: err instanceof GsltError ? err.message : 'Steam could not be reached.',
        };
      }
    },

    /** Proven against Steam before it is stored, like every integration. */
    async setApiKey(apiKey: string): Promise<GsltStatus> {
      const { tokens, banned } = await listWith(apiKey);
      deps.setSetting(GSLT_KEY, encryptSecret(JSON.stringify({ apiKey }), env.SESSION_SECRET));
      return { configured: true, ok: true, tokenCount: tokens.length, banned, error: null };
    },

    /** Forgets the key. Tokens already minted stay on the Steam account. */
    clear() {
      deps.deleteSetting(GSLT_KEY);
    },

    async listTokens(): Promise<GsltToken[]> {
      return (await listWith(requireKey())).tokens;
    },

    /**
     * Mints one token. The memo is the paper trail: it names the tournament
     * and match, so the owner can tell the portal's tokens from their own on
     * Steam's own page.
     */
    async createToken(memo: string, appId: number = CS2_APP_ID): Promise<GsltToken> {
      const created = await call<{ steamid?: string; login_token?: string }>(
        'POST',
        'CreateAccount',
        requireKey(),
        { appid: String(appId), memo: memo.slice(0, 128) },
      );
      if (!created.steamid || !created.login_token) {
        throw new GsltError(
          'Steam did not mint a token. Limited accounts and accounts with a ban on this game cannot create game server tokens.',
        );
      }
      return {
        steamId: created.steamid,
        token: created.login_token,
        appId,
        memo,
        expired: false,
        lastLogonAt: null,
      };
    },

    /** Revives a token Steam expired for sitting unused. */
    async resetToken(steamId: string): Promise<string> {
      const reset = await call<{ login_token?: string }>('POST', 'ResetLoginToken', requireKey(), {
        steamid: steamId,
      });
      if (!reset.login_token) throw new GsltError('Steam did not return a fresh token.');
      return reset.login_token;
    },

    async deleteToken(steamId: string): Promise<void> {
      await call<Record<string, never>>('POST', 'DeleteAccount', requireKey(), {
        steamid: steamId,
      });
    },
  };
}

export type GsltService = ReturnType<typeof createGsltService>;
