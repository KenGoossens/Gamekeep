import { useEffect, useState } from 'react';
import { ApiError, api, formatClock, type GameServer } from '../api.ts';

interface Props {
  server: GameServer;
  /** Called after anything that should refresh the dashboard immediately. */
  onAction: () => void;
  /**
   * Called only when an action actually started, unlike onAction which also
   * fires on a refusal. Used to jump straight to the log.
   */
  onStarted?: () => void;
  /** Operators may restart during a cooldown; the API has always allowed it. */
  canOperate: boolean;
}

export function RestartButton({ server, onAction, onStarted, canOperate }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(server.cooldownRemaining);

  // The server sends the authoritative value on every poll; between polls we
  // tick it down locally so the countdown reads smoothly.
  useEffect(() => {
    setCooldown(server.cooldownRemaining);
    if (server.cooldownRemaining <= 0) return;
    const timer = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(timer);
  }, [server.cooldownRemaining]);

  const job = server.activeJob;
  const working = Boolean(job && job.phase !== 'done' && job.phase !== 'failed');
  const unavailable = server.status.state === 'missing' || Boolean(server.status.error);
  const stopped = !server.status.running && !unavailable;
  const verb = stopped
    ? 'Start'
    : server.updateStrategy === 'pull-recreate'
      ? 'Update & restart'
      : 'Restart';

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.restart(server.id);
      setConfirming(false);
      onStarted?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const retry = Number(err.body.retryAfterSeconds) || 0;
        setCooldown(retry);
        setError(`Someone just restarted this. Try again in ${formatClock(retry)}.`);
      } else if (err instanceof ApiError && err.status === 409) {
        setError('It is already restarting — hang tight.');
      } else if (err instanceof ApiError && err.status === 401) {
        window.location.reload();
      } else {
        setError('Could not start the restart. Try again in a moment.');
      }
      setConfirming(false);
    } finally {
      setSubmitting(false);
      onAction();
    }
  }

  if (working && job) {
    return (
      <div className="actions">
        <span className="progress">
          <span className="spinner" />
          {job.message}
        </span>
        <span className="hint">started by {job.actor}</span>
      </div>
    );
  }

  const occupied = server.players && server.players.online > 0;

  return (
    <>
      <div className="actions">
        {/*
          The cooldown stops a member restarting a server that is still
          booting, which is the guardrail it exists for. It was stopping
          operators too, although the API has always let them through --
          so an owner saw a five-minute wait on a button the server would
          have accepted. They now see the time and may click anyway.
        */}
        <button
          type="button"
          className="btn-primary"
          disabled={(cooldown > 0 && !canOperate) || submitting || unavailable || confirming}
          onClick={() => setConfirming(true)}
        >
          {cooldown > 0 ? (canOperate ? `${verb} anyway (${formatClock(cooldown)})` : `Wait ${formatClock(cooldown)}`) : verb}
        </button>

        {job?.phase === 'done' && cooldown > 0 ? (
          <span className="hint ok">Back up. Give it a minute before restarting again.</span>
        ) : null}
        {job?.phase === 'failed' ? (
          <span className="hint bad">{job.error ?? 'The last restart failed.'}</span>
        ) : null}
        {unavailable ? (
          <span className="hint bad">
            {server.status.error ?? 'This container is not on the server right now.'}
          </span>
        ) : null}
        {error ? <span className="hint bad">{error}</span> : null}
      </div>

      {confirming ? (
        <div className="confirm">
            {/* Said before the rest, because it is the reason to pause: the
                cooldown is normally what stops a second restart landing on a
                server that is still loading its world. */}
            {cooldown > 0 ? (
              <p className="hint bad">
                This was restarted {formatClock(cooldown)} ago and may still be starting up.
                Restarting again now will interrupt that.
              </p>
            ) : null}
          <p>
            {occupied ? (
              <>
                <strong>
                  {server.players!.online} {server.players!.online === 1 ? 'player is' : 'players are'} online
                  right now.
                </strong>{' '}
                Restarting will disconnect {server.players!.online === 1 ? 'them' : 'everyone'}; they can
                rejoin once it is back.
              </>
            ) : stopped ? (
              <>
                This starts the server. It runs an update check first, so give it a minute or two before
                trying to connect.
              </>
            ) : (
              <>
                This stops and starts the container, which applies any pending game update. It usually takes
                a minute or two.
              </>
            )}
          </p>
          <div className="row">
            <button
              type="button"
              className={occupied ? 'btn-danger' : 'btn-primary'}
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? 'Starting…' : `Yes, ${verb.toLowerCase()}`}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
