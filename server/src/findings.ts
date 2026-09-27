/**
 * The shape of every judgement this portal shows before an irreversible act.
 *
 * Shared deliberately: installing a mod and deploying a game server are the
 * same kind of decision -- running someone else's code on this host -- and an
 * operator should not have to learn two vocabularies for it. 'fail' refuses,
 * 'warn' and 'unknown' proceed only once the operator says so, and the
 * difference between those two matters: 'warn' is something we found, while
 * 'unknown' is something we could not establish.
 */
export type FindingState = 'pass' | 'warn' | 'fail' | 'unknown';

export interface Finding {
  id: string;
  label: string;
  state: FindingState;
  summary: string;
  detail?: string;
}

/** True when nothing refused outright. */
export function passes(findings: Finding[]): boolean {
  return !findings.some((f) => f.state === 'fail');
}

/** True when something was found or could not be established. */
export function uncertain(findings: Finding[]): boolean {
  return findings.some((f) => f.state === 'warn' || f.state === 'unknown');
}
