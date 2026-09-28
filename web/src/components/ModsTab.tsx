import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type InstallPlan, type ModStatus, type ModSummary } from '../api.ts';
import { Findings } from './Findings.tsx';
import { WorkshopPanel } from './WorkshopPanel.tsx';

/**
 * Installing mods, with the report shown before anything is written.
 *
 * The wording here matters as much as the code. A mod is third-party code that
 * runs inside the game server, and no check in this portal can decide whether
 * that code is hostile -- so nothing on this screen says "safe". What it says
 * is what was actually established: that the bytes match the publisher's hash,
 * that the archive cannot escape its directory, what the scanners recognised,
 * and whether the dependencies line up.
 */

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function Report({ plan }: { plan: InstallPlan }) {
  return (
    <div className="plan">
      <div className="plan-head">
        <strong>
          {plan.modName} {plan.version}
        </strong>
        <span className="plan-meta">
          {bytes(plan.sizeBytes)} · {plan.fileCount} files → <code>{plan.targetDirectory}</code>
        </span>
      </div>

      <Findings findings={plan.findings} />

      <p className="plan-hash">
        sha256 <code>{plan.sha256}</code>
      </p>
    </div>
  );
}

export function ModsTab({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<ModStatus | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ModSummary[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.mods(serverId));
    } catch {
      setError('Could not read the mod list.');
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function explain(err: unknown, fallback: string): string {
    return err instanceof ApiError && typeof err.body.message === 'string' ? err.body.message : fallback;
  }

  async function find() {
    setBusy('search');
    setError(null);
    setResults(null);
    setPlan(null);
    try {
      const found = await api.searchMods(serverId, query);
      setResults(found.results);
      setHidden(found.hidden ?? 0);
    } catch (err) {
      setError(explain(err, 'Could not search the mod repository.'));
    } finally {
      setBusy(null);
    }
  }

  async function inspect(mod: ModSummary) {
    setBusy(mod.id);
    setError(null);
    setNote(null);
    try {
      setPlan((await api.inspectMod(serverId, mod.id)).plan);
    } catch (err) {
      setError(explain(err, 'Could not inspect that mod.'));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Uploads a file and shows the same report a repository mod gets. The bytes
   * wait on the server until the operator decides, so a change of mind after
   * reading the report does not mean sending 40 MB again.
   */
  async function upload(file: File) {
    setBusy('upload');
    setError(null);
    setNote(null);
    setResults(null);
    setPlan(null);
    try {
      const result = await api.uploadMod(serverId, file, uploadName);
      setUploadToken(result.token);
      setPlan(result.plan);
    } catch (err) {
      setError(explain(err, 'Could not read that file.'));
    } finally {
      setBusy(null);
    }
  }

  async function install(acknowledge: boolean) {
    if (!plan) return;
    setBusy('install');
    setError(null);
    try {
      // An uploaded mod installs by its staging token; there is no repository
      // to ask for it a second time.
      const result = uploadToken
        ? await api.installUploadedMod(serverId, uploadToken, acknowledge)
        : await api.installMod(serverId, plan.modId, plan.version, acknowledge);
      setNote(`Installed ${plan.modName} ${plan.version} — ${result.files} files written.`);
      setPlan(null);
        setUploadToken(null);
      setResults(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.body.plan) setPlan(err.body.plan as InstallPlan);
      setError(explain(err, 'The install was refused.'));
    } finally {
      setBusy(null);
    }
  }

  if (!status) return <p className="empty">{error ?? 'Loading…'}</p>;

  // A game whose server fetches its own mods gets a different screen, because
  // declaring a Workshop id and installing an archive have almost nothing in
  // common beyond both being called "installing a mod".
  if (status.mode === 'workshop') return <WorkshopPanel serverId={serverId} />;

  if (!status.supported) {
    return (
      <>
        <p className="notes">{status.reason}</p>
        <p className="hint">
          You can still add files by hand from the Files tab — that is how mods work for games with
          no repository behind them.
        </p>
      </>
    );
  }

  const source = status.source!;

  return (
    <>
      <p className="notes">
        Mods come from <strong>{source.label}</strong> and nowhere else: a mod runs inside the game
        server, so it may only arrive from a repository this portal knows.
      </p>

      {!status.scannerConfigured ? (
        <p className="hint bad">
          No malware scanner is configured, so downloads are inspected but not scanned. Add a
          VirusTotal key or a ClamAV address in Settings.
        </p>
      ) : null}

      {status.running ? (
        <p className="hint bad">
          This server is running. Stop it before installing or removing a mod.
        </p>
      ) : null}

      {/* ---- what is installed ---- */}
      <h3 className="subhead">Installed</h3>
      {status.installed.length === 0 ? (
        <p className="empty">No mods installed through Gamekeep.</p>
      ) : (
        <ul className="modlist">
          {status.installed.map((m) => (
            <li key={`${m.source}:${m.modId}`}>
              <span className="mod-name">
                {m.modName} <span className="mod-version">{m.version}</span>
              </span>
              <span className="mod-meta">
                {m.files.length} files · by {m.installedBy}
              </span>
              <button
                type="button"
                className="btn-ghost small danger"
                disabled={status.running || busy !== null}
                onClick={async () => {
                  if (!confirm(`Remove ${m.modName}? Its files will be deleted.`)) return;
                  setBusy(m.modId);
                  try {
                    await api.removeMod(serverId, m.source, m.modId);
                    await load();
                  } catch (err) {
                    setError(explain(err, 'Could not remove that mod.'));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ---- finding one ---- */}
      <h3 className="subhead">Add a mod</h3>
      <div className="seedrow">
        <input
          className="modsearch"
          value={query}
          placeholder={source.searchable ? 'Search the repository…' : source.lookupHint}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) void find();
          }}
        />
        <button
          type="button"
          className="btn-ghost small"
          disabled={!query.trim() || busy !== null}
          onClick={() => void find()}
        >
          {busy === 'search' ? 'Looking…' : source.searchable ? 'Search' : 'Look up'}
        </button>
      </div>
      {!source.searchable ? (
        <p className="hint">
          {source.label} publishes no search endpoint, so a mod is named exactly: {source.lookupHint}
        </p>
      ) : null}


      {/* The repository is the safer route and stays first, but most mods can
          simply be downloaded from their own site, and for anything the
          repository does not carry this is the only way. */}
      <h3 className="subhead">Or upload one yourself</h3>
      <div className="seedrow">
        <input
          className="modsearch"
          value={uploadName}
          placeholder="Name for the mod folder (optional — taken from the filename)"
          onChange={(e) => setUploadName(e.target.value)}
        />
        <label className="btn-ghost small uploadbtn">
          {busy === 'upload' ? 'Checking…' : 'Choose a file…'}
          <input
            type="file"
            accept=".zip,.jar,.smod"
            disabled={busy !== null}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so choosing the same file twice still fires a change.
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
        </label>
      </div>
      <p className="hint">
        A .zip, .jar or .smod, up to 192 MB. It gets the same checks as one from the repository,
        except the one that cannot be done: there is no published hash to prove where it came from.
      </p>
      {note ? <p className="hint ok">{note}</p> : null}
      {error ? <p className="hint bad">{error}</p> : null}

      {results && results.length === 0 ? (
        <p className="empty">
          {hidden > 0
            ? `Nothing that runs on a server. ${hidden} client-only mod${hidden === 1 ? '' : 's'} matched and were left out.`
            : 'Nothing found.'}
        </p>
      ) : null}

      {/* So a short list reads as "these are the ones that work" rather than
          as a search that half failed. */}
      {results && results.length > 0 && hidden > 0 ? (
        <p className="hint">
          {hidden} client-only mod{hidden === 1 ? '' : 's'} left out — they have no
          dedicated-server build.
        </p>
      ) : null}
      {results && results.length > 0 && !plan ? (
        <ul className="modlist">
          {results.map((m) => (
            <li key={m.id}>
              <span className="mod-name">
                {m.name}
                {m.deprecated ? <span className="mod-flag">deprecated</span> : null}
                <span className="mod-meta"> {m.summary}</span>
              </span>
              <a className="btn-ghost small" href={m.url} target="_blank" rel="noreferrer">
                Mod page ↗
              </a>
              <button
                type="button"
                className="btn-ghost small"
                disabled={busy !== null}
                onClick={() => void inspect(m)}
              >
                {busy === m.id ? 'Checking…' : 'Check it'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ---- the report, and only then the decision ---- */}
      {plan ? (
        <>
          <Report plan={plan} />
          <div className="actions">
            <button
              type="button"
              className="btn-primary"
              disabled={!plan.installable || status.running || busy !== null}
              onClick={() => void install(plan.needsAcknowledgement)}
            >
              {busy === 'install'
                ? 'Installing…'
                : !plan.installable
                  ? 'Cannot install'
                  : plan.needsAcknowledgement
                    ? 'Install anyway'
                    : 'Install'}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setUploadToken(null);
                setPlan(null);
              }}
            >
              Cancel
            </button>
          </div>
          {plan.installable && plan.needsAcknowledgement ? (
            <p className="hint">
              Nothing blocking, but not everything could be established. Read the rows marked
              caution or unproven before continuing.
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
