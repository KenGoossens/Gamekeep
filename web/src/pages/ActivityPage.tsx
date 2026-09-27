import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../api.ts';
import { AuditFeed } from '../components/AuditFeed.tsx';

export function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [scope, setScope] = useState<{ detail: boolean; origin: boolean }>({ detail: false, origin: false });

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.audit(250).then(
        (r) => {
          if (cancelled) return;
          setEntries(r.entries);
          setScope({ detail: r.canSeeDetail, origin: r.canSeeOrigin });
        },
        () => !cancelled && setEntries([]),
      );
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
        <p>
          {scope.origin
            ? 'Every sign-in, action and refusal, with the address it came from.'
            : scope.detail
              ? 'Every sign-in, action and refusal.'
              : 'What people did to the servers.'}
        </p>
      </div>
      <section className="card">
        {entries === null ? <p className="empty">Loading…</p> : <AuditFeed entries={entries} />}
      </section>
    </>
  );
}
