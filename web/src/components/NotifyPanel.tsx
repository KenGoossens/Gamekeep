import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type NotifySettings } from '../api.ts';

/**
 * Where Gamekeep tells you something went wrong.
 *
 * The default selection is deliberately short. This portal exists because its
 * owner is away, and the point is to be interrupted when a restart did not
 * take — not to receive a message every time one worked. A channel that pings
 * for successes is a channel people mute, and a muted channel tells you
 * nothing on the night it matters.
 */
export function NotifyPanel() {
  const [status, setStatus] = useState<NotifySettings | null>(null);
  const [webhook, setWebhook] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.notifications();
      setStatus(next);
      setChosen(next.events);
    } catch {
      setError('Could not read the notification settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return null;

  function toggle(kind: string) {
    setChosen((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : prev.concat(kind)));
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Notifications</h2>
        <span className={`pill ${status.configured ? 'ok' : 'warn'}`}>
          <span className="dot" />
          {status.configured ? 'Discord connected' : 'nothing is watching'}
        </span>
      </div>

      <p className="notes">
        Without this, a restart that came back but never answered is only an audit row nobody reads
        until somebody happens to look — which rather defeats the point of a portal for when you
        are away.
      </p>

      <label className="field">
        <span>
          Discord webhook{status.configured ? ' — leave empty to keep the current one' : ''}
        </span>
        <input
          type="password"
          value={webhook}
          autoComplete="off"
          placeholder={
            status.configured ? '••••••••' : 'Channel → Edit Channel → Integrations → Webhooks'
          }
          onChange={(e) => setWebhook(e.target.value)}
        />
      </label>
      <p className="hint">
        A webhook posts to one channel and needs no bot. Saving sends a test message, so you will
        know straight away whether it works.
      </p>

      <fieldset className="eventpick">
        <legend>Tell me about</legend>
        {status.available.map((event) => (
          <label key={event.kind} className="eventrow">
            <input
              type="checkbox"
              checked={chosen.includes(event.kind)}
              onChange={() => toggle(event.kind)}
            />
            <span>{event.label}</span>
          </label>
        ))}
      </fieldset>

      {note ? <p className="hint ok">{note}</p> : null}
      {error ? <p className="hint bad">{error}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || (!status.configured && !webhook.trim())}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setNote(null);
            try {
              await api.saveNotifications(webhook.trim() || undefined, chosen);
              setWebhook('');
              setNote('Saved — a test message has been posted to the channel.');
              await load();
            } catch (err) {
              setError(
                err instanceof ApiError && typeof err.body.message === 'string'
                  ? err.body.message
                  : 'Could not save.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Testing…' : status.configured ? 'Save' : 'Connect and test'}
        </button>

        {status.configured ? (
          <button
            type="button"
            className="btn-ghost danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Turn notifications off? Nothing will tell you when a restart fails.'))
                return;
              await api.disableNotifications();
              await load();
            }}
          >
            Turn off
          </button>
        ) : null}
      </div>
    </section>
  );
}
