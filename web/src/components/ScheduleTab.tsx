import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Schedule, type ScheduleAction, type ScheduleList } from '../api.ts';

/**
 * Standing instructions: restart at 05:00, every night, unless people are on.
 *
 * The form speaks in a time and week days rather than cron, because that is
 * the entire vocabulary the job has. The one thing the screen must not let
 * anyone gloss over is whose clock "05:00" is on -- the portal's, which may
 * well be UTC -- so the zone and the portal's current time are shown right
 * beside the input instead of buried in documentation.
 */

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACTION_LABELS: Record<ScheduleAction, string> = {
  restart: 'Restart',
  start: 'Start',
  stop: 'Stop',
  backup: 'Back up',
};

function daysText(days: number[]): string {
  if (days.length === 0) return 'every day';
  if (days.length === 7) return 'every day';
  return days.map((d) => DAY_LABELS[d]).join(', ');
}

function whenText(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ScheduleTab({ serverId }: { serverId: string }) {
  const [list, setList] = useState<ScheduleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The add form.
  const [action, setAction] = useState<ScheduleAction>('restart');
  const [time, setTime] = useState('05:00');
  const [days, setDays] = useState<number[]>([]);
  const [skipOccupied, setSkipOccupied] = useState(true);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      setList(await api.schedules(serverId));
      setError(null);
    } catch {
      setError('Could not read the schedules.');
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function explain(err: unknown, fallback: string): string {
    return err instanceof ApiError && typeof err.body.message === 'string'
      ? err.body.message
      : fallback;
  }

  async function add() {
    setBusy('add');
    setError(null);
    try {
      await api.createSchedule(serverId, { name: name.trim() || undefined, action, time, days, skipOccupied });
      setName('');
      await load();
    } catch (err) {
      setError(explain(err, 'Could not create the schedule.'));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(schedule: Schedule) {
    setBusy(schedule.id);
    setError(null);
    try {
      await api.updateSchedule(serverId, schedule.id, { enabled: !schedule.enabled });
      await load();
    } catch (err) {
      setError(explain(err, 'Could not change the schedule.'));
    } finally {
      setBusy(null);
    }
  }

  async function remove(schedule: Schedule) {
    if (!confirm(`Remove "${schedule.name}"? It will not run again.`)) return;
    setBusy(schedule.id);
    setError(null);
    try {
      await api.deleteSchedule(serverId, schedule.id);
      await load();
    } catch (err) {
      setError(explain(err, 'Could not remove the schedule.'));
    } finally {
      setBusy(null);
    }
  }

  if (!list) return <p className="empty">{error ?? 'Loading…'}</p>;

  return (
    <>
      <p className="notes">
        A schedule runs on the portal’s clock: <strong>{list.timezone}</strong>, where it is
        currently <strong>{list.serverTime}</strong>. It never turns a stopped server back on — a
        restart schedule simply skips until someone starts it again.
      </p>
      {error ? <p className="hint bad">{error}</p> : null}

      {list.schedules.length === 0 ? (
        <p className="empty">No schedules yet. A nightly restart is the classic one.</p>
      ) : (
        <ul className="modlist">
          {list.schedules.map((s) => (
            <li key={s.id}>
              <span className="mod-name">
                {s.name}
                {s.enabled ? null : <span className="mod-version"> (off)</span>}
              </span>
              <span className="mod-meta">
                {ACTION_LABELS[s.action]} at {s.time} · {daysText(s.days)}
                {s.skipOccupied && (s.action === 'restart' || s.action === 'stop')
                  ? ' · skips when players are on'
                  : ''}
              </span>
              <span className="sched-when">
                {s.enabled ? <>next: {whenText(s.nextRunAt)}</> : 'not planned'}
                {s.lastResult ? (
                  <>
                    {' · last: '}
                    {whenText(s.lastRunAt)} — {s.lastResult}
                  </>
                ) : null}
              </span>
              <span className="urow-actions">
                <button
                  type="button"
                  className="btn-ghost small"
                  disabled={busy !== null}
                  onClick={() => void toggle(s)}
                >
                  {busy === s.id ? '…' : s.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="btn-ghost small danger"
                  disabled={busy !== null}
                  onClick={() => void remove(s)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="addrow">
        <select
          value={action}
          aria-label="What the schedule does"
          onChange={(e) => setAction(e.target.value as ScheduleAction)}
        >
          {list.actions.map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </select>
        <input
          type="time"
          value={time}
          aria-label="Time of day"
          style={{ flex: 'none', width: 'auto' }}
          onChange={(e) => setTime(e.target.value)}
        />
        <span className="daypick" role="group" aria-label="Days of the week (none selected means every day)">
          {DAY_LABELS.map((label, day) => (
            <button
              key={label}
              type="button"
              className={days.includes(day) ? 'on' : ''}
              aria-pressed={days.includes(day)}
              onClick={() =>
                setDays((prev) =>
                  prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
                )
              }
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="addrow">
        <input
          type="text"
          value={name}
          placeholder="Name (optional), e.g. Nightly restart"
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        {action === 'restart' || action === 'stop' ? (
          <label className="checkline">
            <input
              type="checkbox"
              checked={skipOccupied}
              onChange={(e) => setSkipOccupied(e.target.checked)}
            />
            skip when players are online
          </label>
        ) : null}
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || !time}
          onClick={() => void add()}
        >
          {busy === 'add' ? 'Adding…' : 'Add schedule'}
        </button>
      </div>
      <p className="hint">
        No days selected means every day. The run itself lands in the activity feed and on Discord,
        exactly like a button press — the actor is the schedule.
      </p>
    </>
  );
}
