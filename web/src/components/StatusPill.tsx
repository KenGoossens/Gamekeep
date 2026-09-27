import type { ContainerState, JobView } from '../api.ts';

interface Props {
  state: ContainerState;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  activeJob: JobView | null;
  error: string | null;
}

export function StatusPill({ state, health, activeJob, error }: Props) {
  if (activeJob && activeJob.phase !== 'done' && activeJob.phase !== 'failed') {
    return <Pill tone="warn" label="Restarting" />;
  }
  if (error) return <Pill tone="bad" label="Docker unreachable" />;

  switch (state) {
    case 'running':
      if (health === 'unhealthy') return <Pill tone="bad" label="Unhealthy" />;
      if (health === 'starting') return <Pill tone="warn" label="Starting" />;
      return <Pill tone="ok" label="Running" />;
    case 'restarting':
      return <Pill tone="warn" label="Restarting" />;
    case 'paused':
      return <Pill tone="warn" label="Paused" />;
    case 'exited':
    case 'dead':
      return <Pill tone="bad" label="Stopped" />;
    case 'created':
      // The container exists but has never run -- "Unknown" reads like a fault.
      return <Pill tone="muted" label="Never started" />;
    case 'missing':
      // The container named in servers.json is not on the host: a config
      // mistake, and worth naming plainly rather than showing "unknown".
      return <Pill tone="bad" label="Container not found" />;
    default:
      return <Pill tone="muted" label="Unknown" />;
  }
}

function Pill({ tone, label }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string }) {
  return (
    <span className={tone === 'muted' ? 'pill' : `pill ${tone}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
