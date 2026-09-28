import { useEffect, useState } from 'react';
import { ApiError, api, type SettingField, type SettingSpec } from '../api.ts';

/**
 * A container's environment variables, with the ones worth explaining
 * explained. The game registry supplies labels, help and types for the
 * variables it recognises; those render as real controls at the top. Every
 * other variable still shows as the plain field it always was -- a spec is a
 * courtesy, never a gate.
 */

/** The yes/no spellings games use, as pairs so a toggle writes the right one. */
const BOOL_PAIRS: Array<[string, string]> = [
  ['true', 'false'],
  ['1', '0'],
  ['yes', 'no'],
  ['on', 'off'],
];

/** Which vocabulary this value speaks, or null when it is not a boolean. */
function boolPair(value: string): [string, string] | null {
  const v = value.trim().toLowerCase();
  return BOOL_PAIRS.find(([yes, no]) => v === yes || v === no) ?? null;
}

function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return BOOL_PAIRS.some(([yes]) => v === yes);
}

export function SettingsTab({
  serverId,
  onChanged,
  readOnly,
}: {
  serverId: string;
  onChanged: () => void;
  /** The server is running, so the values can be read but not changed. */
  readOnly: boolean;
}) {
  const [fields, setFields] = useState<SettingField[] | null>(null);
  const [specs, setSpecs] = useState<SettingSpec[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.settings(serverId).then(
      (r) => {
        if (cancelled) return;
        setFields(r.settings);
        setSpecs(r.specs ?? []);
      },
      (err) =>
        !cancelled &&
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Only operators and owners can change settings.'
            : 'Could not read the settings.',
        ),
    );
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const dirty = Object.keys(edits).length > 0;

  async function apply() {
    setBusy(true);
    setError(null);
    setSteps(null);
    try {
      const result = await api.applySettings(serverId, edits);
      setSteps(result.steps.length > 0 ? result.steps : ['Nothing changed.']);
      setEdits({});
      const next = await api.settings(serverId);
      setFields(next.settings);
      setSpecs(next.specs ?? []);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Applying the settings failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (error && !fields) return <p className="hint bad">{error}</p>;
  if (!fields) return <p className="empty">Loading…</p>;

  const specFor = new Map(specs.map((s) => [s.key, s]));
  const known = fields.filter((f) => specFor.has(f.key));
  const rest = fields.filter((f) => !specFor.has(f.key));
  const valueOf = (f: SettingField) => edits[f.key] ?? f.value;
  const setValue = (key: string, value: string) =>
    setEdits((prev) => ({ ...prev, [key]: value }));

  /** The right control for a field, spec'd or inferred from its value. */
  function control(f: SettingField, spec: SettingSpec | undefined) {
    const value = valueOf(f);

    // A masked secret stays a plain input whatever its spec claims: the dots
    // placeholder means "unchanged" and a toggle would destroy that.
    if (!f.masked) {
      const wantsBool = spec?.type === 'boolean' || (!spec && boolPair(f.value));
      const pair = boolPair(f.value) ?? ['true', 'false'];
      if (wantsBool && boolPair(value)) {
        return (
          <label className="checkline">
            <input
              type="checkbox"
              checked={isTruthy(value)}
              disabled={readOnly}
              onChange={(e) => setValue(f.key, e.target.checked ? pair[0] : pair[1])}
            />
            {isTruthy(value) ? pair[0] : pair[1]}
          </label>
        );
      }

      if (spec?.type === 'select') {
        return (
          <select
            value={value}
            disabled={readOnly}
            onChange={(e) => setValue(f.key, e.target.value)}
          >
            {/* The current value stays choosable even when it is not on the
                list, so opening the menu never silently changes anything. */}
            {!(spec.options ?? []).includes(value) ? (
              <option value={value}>{value || '(empty)'}</option>
            ) : null}
            {(spec.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      }

      if (spec?.type === 'number' || (!spec && /^-?\d+$/.test(f.value) && f.value !== '')) {
        return (
          <input
            type="number"
            value={value}
            min={spec?.min}
            max={spec?.max}
            readOnly={readOnly}
            onChange={(e) => setValue(f.key, e.target.value)}
          />
        );
      }
    }

    return (
      <input
        value={value}
        readOnly={readOnly}
        onChange={(e) => setValue(f.key, e.target.value)}
      />
    );
  }

  function renderField(f: SettingField) {
    const spec = specFor.get(f.key);
    return (
      <label className="field" key={f.key}>
        <span>
          {spec ? (
            <>
              {spec.label} <code className="fieldkey">{f.key}</code>
            </>
          ) : (
            f.key
          )}
          {f.masked ? ' (leave as-is to keep the current value)' : ''}
        </span>
        {control(f, spec)}
        {spec?.help ? <span className="fieldhelp">{spec.help}</span> : null}
      </label>
    );
  }

  return (
    <>
      <p className="notes">
        These are the container's environment variables. Saving{' '}
        <strong>recreates the container</strong>, which takes the server offline for as long as it
        needs to start again — there is no way to change them on a running container.
      </p>

      {readOnly ? (
        <p className="hint">
          The server is running, so these are shown as they are but cannot be changed. Stop it
          first — which is also what lets you check what a newly deployed server was given.
        </p>
      ) : null}

      {known.length > 0 ? (
        <>
          <h3 className="subhead">Game settings</h3>
          {known.map(renderField)}
          {rest.length > 0 ? <h3 className="subhead">Everything else</h3> : null}
        </>
      ) : null}
      {rest.map(renderField)}

      {steps ? (
        <div className="handout">
          <p>Applied:</p>
          <ul className="feed">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="hint bad">{error}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={readOnly || !dirty || busy}
          onClick={() => {
            const names = Object.keys(edits).join(', ');
            if (confirm(`Apply changes to ${names}? The server will restart.`)) void apply();
          }}
        >
          {busy
            ? 'Applying…'
            : `Apply ${Object.keys(edits).length || ''} change${Object.keys(edits).length === 1 ? '' : 's'}`}
        </button>
        {dirty ? (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEdits({})}>
            Discard
          </button>
        ) : null}
      </div>
    </>
  );
}
