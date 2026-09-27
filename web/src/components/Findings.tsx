import type { Finding } from '../api.ts';

/**
 * One judgement per row, used before anything irreversible.
 *
 * Installing a mod and deploying a game server are the same kind of decision,
 * so they read the same. The state is a word first and a colour second, and
 * none of the words is "safe": 'ok' means a specific check passed, 'unproven'
 * means it could not be established, and the difference is the point.
 */
const WORD: Record<Finding['state'], string> = {
  pass: 'ok',
  warn: 'caution',
  fail: 'blocked',
  unknown: 'unproven',
};

export function Findings({ findings }: { findings: Finding[] }) {
  return (
    <ul className="findings">
      {findings.map((f) => (
        <li key={f.id} className={`finding finding-${f.state}`}>
          <span className="finding-state">{WORD[f.state]}</span>
          <span className="finding-body">
            <strong>{f.label}</strong> {f.summary}
            {f.detail ? <em>{f.detail}</em> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
