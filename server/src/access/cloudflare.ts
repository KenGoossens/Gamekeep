/**
 * Managing who may reach this portal, through Cloudflare Access.
 *
 * Cloudflare Access is the gate in front of GameKeepr's own login, and a policy
 * there is the guest list. Adding a friend means editing that list, which
 * until now meant opening the Zero Trust dashboard.
 *
 * Two rules shape everything here.
 *
 * The token is expected to be scoped to "Access: Apps and Policies — Edit" and
 * nothing else. A broader one would make an operator password equivalent to
 * control of the whole domain, including the ability to remove the very gate
 * protecting this portal.
 *
 * And a policy is read, modified in one specific way, and written back whole.
 * Cloudflare's update replaces the policy, so anything not sent is dropped:
 * the require and exclude blocks, the decision, the session duration and any
 * include rule that is not an email address are all carried across untouched.
 * This matters more than it looks. Two include rules are OR'd -- which is why
 * an authentication-method restriction has to live under require -- so a
 * careless rewrite of include would not merely lose a rule, it would quietly
 * widen who gets in.
 */

const API = 'https://api.cloudflare.com/client/v4';

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

/** One entry in include/exclude/require. Only the email shape is understood. */
type Rule = Record<string, unknown>;

interface RawPolicy {
  id: string;
  name: string;
  decision: string;
  include: Rule[];
  exclude?: Rule[];
  require?: Rule[];
  session_duration?: string;
  app_count?: number;
  [key: string]: unknown;
}

export interface PolicySummary {
  id: string;
  name: string;
  decision: string;
  /** Email addresses listed in the include block. */
  emails: string[];
  /**
   * Include rules that are not a plain email -- a domain, a group, an IP
   * range. Counted so the UI can say they exist without pretending to manage
   * them.
   */
  otherIncludes: number;
  requireRules: number;
  excludeRules: number;
  appCount: number;
}

function emailOf(rule: Rule): string | null {
  const email = (rule as { email?: { email?: unknown } }).email?.email;
  return typeof email === 'string' ? email : null;
}

/** Cloudflare normalises addresses to lower case; compare the same way. */
function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Deliberately permissive: Cloudflare is the authority on what it accepts. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function summarise(policy: RawPolicy): PolicySummary {
  const include = policy.include ?? [];
  return {
    id: policy.id,
    name: policy.name,
    decision: policy.decision,
    emails: include.map(emailOf).filter((e): e is string => e !== null),
    otherIncludes: include.filter((r) => emailOf(r) === null).length,
    requireRules: (policy.require ?? []).length,
    excludeRules: (policy.exclude ?? []).length,
    appCount: policy.app_count ?? 0,
  };
}

export function createAccessClient(config: { token: string; accountId: string }) {
  const { token, accountId } = config;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20_000),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new AccessError(`Could not reach Cloudflare: ${(err as Error).message}`, 'unreachable');
    }

    if (response.status === 401 || response.status === 403) {
      throw new AccessError(
        'Cloudflare refused the token. It needs Access: Apps and Policies — Edit on this account.',
        'unauthorized',
      );
    }

    const body = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!body?.success) {
      const detail = body?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${response.status}`;
      throw new AccessError(`Cloudflare rejected the request: ${detail}`, 'rejected');
    }
    return body.result;
  }

  async function listPolicies(): Promise<PolicySummary[]> {
    const policies = await call<RawPolicy[]>(`/accounts/${encodeURIComponent(accountId)}/access/policies`);
    return (policies ?? []).map(summarise);
  }

  async function readPolicy(policyId: string): Promise<RawPolicy> {
    const policy = await call<RawPolicy>(
      `/accounts/${encodeURIComponent(accountId)}/access/policies/${encodeURIComponent(policyId)}`,
    );
    if (!policy?.id) throw new AccessError('No such policy on this account.', 'not-found');
    return policy;
  }

  /**
   * Writes the policy back with a new include list and everything else exactly
   * as it was read. The whole object is sent, not a patch, because the API
   * replaces rather than merges.
   */
  async function writeInclude(policy: RawPolicy, include: Rule[]): Promise<PolicySummary> {
    const updated = await call<RawPolicy>(
      `/accounts/${encodeURIComponent(accountId)}/access/policies/${encodeURIComponent(policy.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...policy,
          include,
          // Sent explicitly even though they are in the spread: leaving any of
          // these out is how a policy silently loses its restrictions.
          name: policy.name,
          decision: policy.decision,
          exclude: policy.exclude ?? [],
          require: policy.require ?? [],
        }),
      },
    );
    return summarise(updated);
  }

  return {
    listPolicies,

    async policy(policyId: string): Promise<PolicySummary> {
      return summarise(await readPolicy(policyId));
    },

    /** Proves the token works and the policy exists, before anything is stored. */
    async test(policyId: string): Promise<{ detail: string; policy: PolicySummary }> {
      const policy = summarise(await readPolicy(policyId));
      return {
        detail: `"${policy.name}" — ${policy.emails.length} address(es), used by ${policy.appCount} application(s)`,
        policy,
      };
    },

    async addEmail(policyId: string, email: string): Promise<PolicySummary> {
      const address = email.trim().toLowerCase();
      if (!looksLikeEmail(address)) {
        throw new AccessError('That does not look like an email address.', 'bad-email');
      }

      const policy = await readPolicy(policyId);
      const include = policy.include ?? [];
      if (include.some((rule) => { const e = emailOf(rule); return e !== null && same(e, address); })) {
        throw new AccessError('That address is already on this policy.', 'already-present');
      }

      return writeInclude(policy, [...include, { email: { email: address } }]);
    },

    async removeEmail(policyId: string, email: string): Promise<PolicySummary> {
      const policy = await readPolicy(policyId);
      const include = policy.include ?? [];
      const remaining = include.filter((rule) => {
        const e = emailOf(rule);
        return e === null || !same(e, email);
      });

      if (remaining.length === include.length) {
        throw new AccessError('That address is not on this policy.', 'not-present');
      }
      /*
       * A policy with an empty include matches nobody, and Cloudflare will
       * either refuse it or lock everyone out of the application it guards --
       * including whoever is clicking this button.
       */
      if (remaining.length === 0) {
        throw new AccessError(
          'That is the last rule on this policy. Removing it would lock everyone out, so it has to be done in Cloudflare with your eyes open.',
          'last-rule',
        );
      }
      return writeInclude(policy, remaining);
    },
  };
}

export type AccessClient = ReturnType<typeof createAccessClient>;
