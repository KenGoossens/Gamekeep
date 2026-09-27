import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The live console, followed as it happens.
 *
 * Two behaviours make a log viewer usable rather than merely present. It
 * follows the tail until you scroll up, and then it stops and says so --
 * nothing is more irritating than reading a line and being yanked away from
 * it. And it keeps a fixed number of lines: a chatty server will produce tens
 * of thousands in an evening, and a page that renders them all becomes
 * unusable long before it runs out of memory.
 */

interface Line {
  id: number;
  text: string;
  stream: 'stdout' | 'stderr' | 'system';
}

/** Past this the page slows down and nobody is reading that far back anyway. */
const MAX_LINES = 3000;
/** How close to the bottom still counts as "following". */
const STICK_PX = 40;

/** Docker prefixes each line with an RFC3339 timestamp when asked to. */
function split(raw: string): { at: string | null; text: string } {
  const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s(.*)$/s.exec(raw);
  return match ? { at: match[1]!, text: match[2]! } : { at: null, text: raw };
}

function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

export function LogsTab({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState(true);
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<string | null>('Connecting…');

  const box = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  const append = useCallback((text: string, stream: Line['stream']) => {
    setLines((prev) => {
      const next = prev.concat({ id: nextId.current++, text, stream });
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    if (!live) return;
    setStatus('Connecting…');

    /*
     * EventSource, not fetch: it reconnects by itself when the tunnel drops a
     * long-lived connection, which over a home internet link it will. The
     * cookie goes with it because this is a same-origin request.
     */
    const source = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/logs/stream?tail=400`);

    source.addEventListener('open', () => setStatus(null));
    source.addEventListener('stdout', (e) => append((e as MessageEvent<string>).data, 'stdout'));
    source.addEventListener('stderr', (e) => append((e as MessageEvent<string>).data, 'stderr'));
    source.addEventListener('ended', (e) => {
      append((e as MessageEvent<string>).data, 'system');
      setStatus('The server stopped writing. Reconnecting when it starts again.');
    });
    source.addEventListener('error', () => {
      // Fires both on a dropped connection and on a refusal; EventSource
      // retries on its own, so this only needs to say what is happening.
      setStatus('Connection lost — retrying…');
    });

    return () => source.close();
  }, [serverId, live, append]);

  // Sticks to the bottom only while the reader is already there.
  useEffect(() => {
    const el = box.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [lines, following]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines;
  }, [lines, filter]);

  function onScroll() {
    const el = box.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX);
  }

  function download() {
    const blob = new Blob([lines.map((l) => l.text).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${serverId}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <p className="notes">
        The container’s console, as it happens. Logs can contain player addresses and any password
        the server prints at start-up, which is why this sits at operator level.
      </p>

      <div className="logbar">
        <span className={`pill ${live && !status ? 'ok' : 'warn'}`}>
          <span className="dot" />
          {live ? (status ?? 'live') : 'paused'}
        </span>

        <input
          className="modsearch"
          value={filter}
          placeholder="Filter lines…"
          onChange={(e) => setFilter(e.target.value)}
        />

        <button type="button" className="btn-ghost small" onClick={() => setLive((v) => !v)}>
          {live ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className="btn-ghost small" onClick={() => setLines([])}>
          Clear
        </button>
        <button
          type="button"
          className="btn-ghost small"
          disabled={lines.length === 0}
          onClick={download}
        >
          Download
        </button>
      </div>

      {!following ? (
        <button
          type="button"
          className="btn-ghost small jumpdown"
          onClick={() => {
            setFollowing(true);
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Paused while you scroll — jump to the newest
        </button>
      ) : null}

      <div className="logbox" ref={box} onScroll={onScroll} role="log" aria-live="off">
        {shown.length === 0 ? (
          <p className="empty">
            {filter ? 'No lines match that filter.' : 'Nothing yet.'}
          </p>
        ) : (
          shown.map((line) => {
            const { at, text } = split(line.text);
            return (
              <div key={line.id} className={`logline logline-${line.stream}`}>
                <span className="logtime">{clock(at)}</span>
                <span className="logtext">{text}</span>
              </div>
            );
          })
        )}
      </div>

      <p className="hint">
        Showing {shown.length}
        {filter ? ` of ${lines.length}` : ''} line{shown.length === 1 ? '' : 's'}; the oldest are
        dropped past {MAX_LINES}.
      </p>
    </>
  );
}
