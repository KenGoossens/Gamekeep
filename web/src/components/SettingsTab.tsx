import { useEffect, useState } from 'react';
import { ApiError, api, type SettingField } from '../api.ts';

export function SettingsTab({ serverId, onChanged }: { serverId: string; onChanged: () => void }) {
  const [fields, setFields] = useState<SettingField[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.settings(serverId).then(
      (r) => !cancelled && setFields(r.settings),
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
      setFields((await api.settings(serverId)).settings);
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

  return (
    <>
      <p className="notes">
        These are the container's environment variables. Saving <strong>recreates the container</strong>,
        which takes the server offline for as long as it needs to start again — there is no way to change
        them on a running container.
      </p>

      {fields.map((f) => (
        <label className="field" key={f.key}>
          <span>
            {f.key}
            {f.masked ? ' (leave as-is to keep the current value)' : ''}
          </span>
          <input
            value={edits[f.key] ?? f.value}
            onChange={(e) => setEdits((prev) => ({ ...prev, [f.key]: e.target.value }))}
          />
        </label>
      ))}

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
          disabled={!dirty || busy}
          onClick={() => {
            const names = Object.keys(edits).join(', ');
            if (confirm(`Apply changes to ${names}? The server will restart.`)) void apply();
          }}
        >
          {busy ? 'Applying…' : `Apply ${Object.keys(edits).length || ''} change${Object.keys(edits).length === 1 ? '' : 's'}`}
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
