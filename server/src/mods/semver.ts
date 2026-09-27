/**
 * Just enough semver to answer "does the installed loader satisfy this mod's
 * requirement", which is the whole of the compatibility question.
 *
 * Mod repositories state requirements as ranges like "^3.12.0" or ">=2026.3.1",
 * so a comparison that ignores them would either block valid installs or wave
 * broken ones through. A wrong answer here is a game server that will not
 * start, so an unparseable range is reported as unknown rather than guessed at.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers, which sort *below* the same version without them. */
  pre: string[];
}

export function parse(raw: string): Version | null {
  const text = raw.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Returns <0, 0 or >0, ordering pre-releases below their release. */
export function compare(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  // A version with a pre-release is older than the same one without.
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;

  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;

    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    // Numeric identifiers compare numerically and rank below alphanumeric ones.
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The upper bound implied by ^ and ~, which differ only in what they pin. */
function ceiling(v: Version, operator: '^' | '~'): Version {
  if (operator === '~') return { major: v.major, minor: v.minor + 1, patch: 0, pre: [] };
  // ^0.x.y only allows patch moves: before 1.0.0 the minor is the breaking one.
  if (v.major === 0) {
    return v.minor === 0
      ? { major: 0, minor: 0, patch: v.patch + 1, pre: [] }
      : { major: 0, minor: v.minor + 1, patch: 0, pre: [] };
  }
  return { major: v.major + 1, minor: 0, patch: 0, pre: [] };
}

function satisfiesOne(version: Version, comparator: string): boolean | null {
  const text = comparator.trim();
  if (text === '' || text === '*' || text === 'x') return true;

  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(text);
  if (!match) return null;
  const operator = match[1] ?? '=';
  const bound = parse(match[2]!);
  if (!bound) return null;

  const cmp = compare(version, bound);
  switch (operator) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^':
    case '~':
      return cmp >= 0 && compare(version, ceiling(bound, operator)) < 0;
    default:
      return null;
  }
}

/**
 * Evaluates a range such as ">=1.2.0 <2.0.0" or "^1.0.0 || ^2.0.0".
 * Returns null when the range cannot be understood, which the caller must
 * report as unknown rather than treat as a pass.
 */
export function satisfies(rawVersion: string, range: string): boolean | null {
  const version = parse(rawVersion);
  if (!version) return null;

  let sawUnknown = false;
  for (const alternative of range.split('||')) {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return true;

    let all = true;
    for (const comparator of comparators) {
      const result = satisfiesOne(version, comparator);
      if (result === null) {
        sawUnknown = true;
        all = false;
        break;
      }
      if (!result) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  // An alternative we could not parse might have matched, so this is "don't
  // know", not "no".
  return sawUnknown ? null : false;
}
