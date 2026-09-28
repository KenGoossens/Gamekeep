import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type LogFile } from '../api.ts';

/**
 * The live console, followed as it happens.
 *
 * Two sources, and the difference matters. The container log is whatever the
 * server writes to stdout — for Valheim that is everything, for Satisfactory
 * it is mostly the launcher. The game's own log files carry the detail, and
 * they live somewhere different for every game.
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
  stream: 'stdout' | 'stderr' | 'system' | 'stdin';
}

/** Past this the page slows down and nobody is reading that far back anyway. */
const MAX_LINES = 3000;
/** How close to the bottom still counts as "following". */
const STICK_PX = 40;
/** How often a log file is checked for new bytes. */
const POLL_MS = 2000;
/** On opening a file, start this far from the end rather than at the top. */
const BACKFILL_BYTES = 60 * 1024;

const CONTAINER = '@container';

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

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function LogsTab({ serverId }: { serverId: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState(true);
  const [following, setFollowing] = useState(true);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<string | null>('Connecting…');
  const [source, setSource] = useState(CONTAINER);
  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [command, setCommand] = useState('');
  const [sendState, setSendState] = useState<'idle' | 'sending'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);

  const box = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const offset = useRef(0);

  const append = useCallback((text: string, stream: Line['stream']) => {
    setLines((prev) => {
      const next = prev.concat({ id: nextId.current++, text, stream });
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  // Which log files this server keeps, asked once.
  useEffect(() => {
    api.logFiles(serverId).then(
      (r) => setFiles(r.files),
      () => setFiles([]),
    );
  }, [serverId]);

  // Starting over whenever the source changes: the two are different streams
  // of text and mixing them would be nonsense.
  /**
   * A command goes to the game's stdin; its answer comes back through the log
   * stream like any other output. The game does not echo what it was typed,
   * so the sent line is added locally -- otherwise the console reads as if it
   * answered a question nobody asked.
   */
  async function send() {
    const line = command.trim();
    if (!line || sendState !== 'idle') return;
    setSendState('sending');
    setSendError(null);
    try {
      await api.sendConsole(serverId, line);
      append(`${new Date().toISOString()} > ${line}`, 'stdin');
      setCommand('');
    } catch (err) {
      setSendError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
          : 'Could not send that.',
      );
    } finally {
      setSendState('idle');
    }
  }

  useEffect(() => {
    setLines([]);
    offset.current = 0;
  }, [source, serverId]);

  // ---- the container console, streamed ----
  useEffect(() => {
    if (!live || source !== CONTAINER) return;
    setStatus('Connecting…');

    /*
     * EventSource, not fetch: it reconnects by itself when the tunnel drops a
     * long-lived connection, which over a home internet link it will. The
     * cookie goes with it because this is a same-origin request.
     */
    const stream = new EventSource(`/api/servers/${encodeURIComponent(serverId)}/logs/stream?tail=400`);

    stream.addEventListener('open', () => setStatus(null));
    stream.addEventListener('stdout', (e) => append((e as MessageEvent<string>).data, 'stdout'));
    stream.addEventListener('stderr', (e) => append((e as MessageEvent<string>).data, 'stderr'));
    stream.addEventListener('ended', (e) => {
      append((e as MessageEvent<string>).data, 'system');
      setStatus('The server stopped writing. Reconnecting when it starts again.');
    });
    stream.addEventListener('error', () => setStatus('Connection lost — retrying…'));

    return () => stream.close();
  }, [serverId, live, source, append]);

  // ---- a log file, polled ----
  useEffect(() => {
    if (!live || source === CONTAINER) return;
    let cancelled = false;

    const chosen = files?.find((f) => f.path === source);
    // Opening a large log at byte zero would send megabytes nobody asked for;
    // the last stretch is what anyone means by "the log".
    offset.current = Math.max(0, (chosen?.sizeBytes ?? 0) - BACKFILL_BYTES);

    async function poll() {
      if (cancelled) return;
      try {
        const chunk = await api.logFile(serverId, source, offset.current);
        if (cancelled) return;
        setStatus(null);

        if (chunk.rotated) {
          append('— the file was rotated; reading the new one from the top —', 'system');
          offset.current = 0;
        } else {
          offset.current = chunk.size;
          for (const line of chunk.text.split('\n')) {
            if (line.length > 0) append(line, 'stdout');
          }
        }
      } catch {
        if (!cancelled) setStatus('Could not read that file — retrying…');
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverId, live, source, files, append]);

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
    const name = source === CONTAINER ? 'container' : (source.split('/').pop() ?? 'log');
    const blob = new Blob([lines.map((l) => l.text).join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${serverId}-${name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const interesting = (files ?? []).filter((f) => !f.noise);
  const rest = (files ?? []).filter((f) => f.noise);

  return (
    <>
      <p className="notes">
        The container’s console is whatever the server writes to stdout. Some games keep their own
        log file with far more detail — those are listed below when they exist. Logs can contain
        player addresses and any password the server prints at start-up, which is why this sits at
        operator level.
      </p>

      <div className="logbar">
        <span className={`pill ${live && !status ? 'ok' : 'warn'}`}>
          <span className="dot" />
          {live ? (status ?? 'live') : 'paused'}
        </span>

        <select
          className="rolepick"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-label="Log source"
        >
          <option value={CONTAINER}>Container console</option>
          {interesting.length > 0 ? (
            <optgroup label="Game logs">
              {interesting.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label} ({bytes(f.sizeBytes)})
                </option>
              ))}
            </optgroup>
          ) : null}
          {rest.length > 0 ? (
            <optgroup label="Steam and system logs">
              {rest.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.label} ({bytes(f.sizeBytes)})
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>

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

      {files !== null && files.length === 0 ? (
        <p className="hint">
          This server keeps no log files of its own — everything it has to say goes to the console
          above.
        </p>
      ) : null}

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
          <p className="empty">{filter ? 'No lines match that filter.' : 'Nothing yet.'}</p>
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

      {source === CONTAINER ? (
        <>
          <div className="consolerow">
            <span className="consoleprompt" aria-hidden="true">&gt;</span>
            <input
              type="text"
              value={command}
              maxLength={500}
              placeholder="Console command — save-all, say Server restart in 5…, kick <name>"
              aria-label="Console command"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
            <button
              type="button"
              className="btn-ghost small"
              disabled={sendState !== 'idle' || !command.trim()}
              onClick={() => void send()}
            >
              {sendState === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>
          {sendError ? <p className="hint bad">{sendError}</p> : null}
        </>
      ) : null}

      <p className="hint">
        Showing {shown.length}
        {filter ? ` of ${lines.length}` : ''} line{shown.length === 1 ? '' : 's'}; the oldest are
        dropped past {MAX_LINES}.
      </p>
    </>
  );
}
