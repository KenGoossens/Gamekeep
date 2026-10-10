import { useEffect, useState } from 'react';
import { api, type TelemetryState } from '../api.ts';
import { Modal } from './Modal.tsx';

/**
 * The invitation, shown ONCE to an owner who has never been asked — which in
 * practice means a portal that upgraded into this feature, since a fresh
 * install answers the question during setup. Either answer spends the
 * invitation: nobody is asked twice, and Settings keeps the switch forever.
 *
 * It shows the literal payload before the choice, same as the Settings card:
 * an invitation that hides what it asks for is not an invitation.
 */
export function TelemetryInvite({ isOwner }: { isOwner: boolean }) {
  const [state, setState] = useState<TelemetryState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    // A moment after landing, not in the first paint: an invitation that
    // ambushes someone mid-click is a dark pattern, however friendly.
    const timer = setTimeout(() => {
      api.telemetry().then(
        (s) => {
          if (s.invitePending && s.endpointConfigured) {
            setState(s);
            setOpen(true);
          }
        },
        () => undefined,
      );
    }, 2500);
    return () => clearTimeout(timer);
  }, [isOwner]);

  if (!open || !state) return null;

  const close = () => {
    setOpen(false);
    void api.dismissTelemetryInvite().catch(() => undefined);
  };

  return (
    <Modal title="Count this install?" onClose={close}>
      <p className="notes">
        GameKeepr can send <strong>one anonymous ping per hour</strong> so the project knows how many
        people run it and which games they play. It is <strong>off</strong> right now, and this is
        the only time you will be asked — the switch lives under Settings either way.
      </p>
      <p className="notes">
        Everyone who shares sees the result: the numbers land on a{' '}
        {state.statsUrl ? (
          <a href={state.statsUrl} target="_blank" rel="noreferrer">
            public statistics page ↗
          </a>
        ) : (
          'public statistics page'
        )}{' '}
        that anyone can read. No server names, no addresses, no players' names, no logs — here is
        the whole thing, exactly as it would be sent:
      </p>
      <pre className="handout" style={{ overflowX: 'auto', fontSize: '0.78rem', maxHeight: 280 }}>
        {JSON.stringify(state.payload, null, 2)}
      </pre>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setTelemetry(true);
            } finally {
              setBusy(false);
              setOpen(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Yes, count me in'}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={close}>
          No thanks
        </button>
      </div>
    </Modal>
  );
}
