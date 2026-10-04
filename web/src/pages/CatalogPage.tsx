import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type CatalogApp,
  type CatalogTemplate,
  type DeployReview,
  type ExtraParameters,
  type Finding,
} from '../api.ts';
import { navigate } from '../router.ts';
import { Findings } from '../components/Findings.tsx';
import { SteamCatalog } from '../components/SteamCatalog.tsx';

export function CatalogPage() {
  /*
   * Two ways in: the curated Unraid catalogue (templates from trusted
   * publishers) and the whole of Steam (containers the portal composes
   * itself). Different trust stories, so they are separate screens rather
   * than merged results.
   */
  const [source, setSource] = useState<'unraid' | 'steam'>('unraid');
  const [query, setQuery] = useState('');
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [total, setTotal] = useState(0);
  const [installed, setInstalled] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogTemplate | null>(null);

  const load = useCallback(async (q: string, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.catalog(q, refresh);
      setApps(data.apps);
      setTotal(data.total);
      setInstalled(data.installed);
    } catch {
      setError('Could not reach the Community Applications feed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(query), 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  async function open(app: CatalogApp) {
    setError(null);
    try {
      setSelected(await api.catalogTemplate(app.id));
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? `Could not read that template: ${err.body.message}`
          : 'Could not read that template.',
      );
    }
  }

  if (selected) {
    return <DeployForm detail={selected} onCancel={() => setSelected(null)} />;
  }

  return (
    <>
      <div className="page-head">
        <h1>Add a game server</h1>
        <p>
          {source === 'unraid'
            ? `${total} game servers from trusted publishers in Community Applications. Deploying creates a container on your Unraid server.`
            : 'Any dedicated server on Steam, as a container GameKeepr composes itself on Valve’s official steamcmd image.'}
        </p>
      </div>

      <nav className="tabs" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={source === 'unraid' ? 'tab active' : 'tab'}
          onClick={() => setSource('unraid')}
        >
          Unraid apps
        </button>
        <button
          type="button"
          className={source === 'steam' ? 'tab active' : 'tab'}
          onClick={() => setSource('steam')}
        >
          Steam
        </button>
      </nav>

      {source === 'steam' ? (
        <SteamCatalog />
      ) : (
      <>
      <div className="addrow" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <input
          placeholder="Search for a game…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="button" className="btn-ghost" onClick={() => void load(query, true)}>
          Refresh feed
        </button>
      </div>

      {error ? <div className="banner">{error}</div> : null}
      {loading ? <p className="empty">Loading…</p> : null}

      <ul className="catalog">
        {apps.map((app) => (
          <li key={app.id}>
            {app.icon ? <img src={app.icon} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className="noicon" />}
            <div className="catalog-body">
              <span className="uname">{app.name}</span>
              <span className="hint">
                {app.publisher} · {app.downloads.toLocaleString()} downloads
              </span>
              <p className="catalog-overview">{app.overview.slice(0, 180)}</p>
            </div>
            {installed.includes(app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')) ? (
              <span className="pill plain">already added</span>
            ) : (
              <button type="button" className="btn-primary small" onClick={() => void open(app)}>
                Configure
              </button>
            )}
          </li>
        ))}
      </ul>
      {!loading && apps.length === 0 ? <p className="empty">Nothing matched that search.</p> : null}
      </>
      )}
    </>
  );
}

function DeployForm({ detail, onCancel }: { detail: CatalogTemplate; onCancel: () => void }) {
  const { app, template } = detail;
  const [name, setName] = useState(detail.suggestedName);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      template.fields.filter((f) => f.type === 'Variable').map((f) => [f.target, f.value]),
    ),
  );
  const [ports, setPorts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      template.fields.filter((f) => f.type === 'Port').map((f) => [f.target, f.value || f.target]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ serverId: string; appdataPath: string } | null>(null);

  const [review, setReview] = useState<DeployReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const [extra, setExtra] = useState<ExtraParameters>({ variables: [], ports: [], paths: [] });
  const extraCount = extra.variables.length + extra.ports.length + extra.paths.length;

  /*
   * Three small helpers rather than three copies of the same splice. Typed on
   * the key so a port row cannot be edited as if it were a variable.
   */
  function addExtra<K extends keyof ExtraParameters>(key: K, row: ExtraParameters[K][number]) {
    setExtra((prev) => ({ ...prev, [key]: [...prev[key], row] }));
  }

  function editExtra<K extends keyof ExtraParameters>(
    key: K,
    index: number,
    patch: Partial<ExtraParameters[K][number]>,
  ) {
    setExtra((prev) => ({
      ...prev,
      [key]: prev[key].map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));
  }

  function dropExtra<K extends keyof ExtraParameters>(key: K, index: number) {
    setExtra((prev) => ({ ...prev, [key]: prev[key].filter((_, i) => i !== index) }));
  }

  // Fetched as soon as the form opens, so the operator is reading what this
  // app asks for while they fill in the name rather than after they commit.
  useEffect(() => {
    let live = true;
    api.reviewApp(app.id).then(
      (r) => {
        if (live) setReview(r);
      },
      () => {
        if (live) setReviewError('Could not check this app before deploying.');
      },
    );
    return () => {
      live = false;
    };
  }, [app.id]);

  /*
   * The join settings — password, world, server name — get their own section
   * at the top instead of being buried among a template's dozen variables.
   * A spec whose variable the template declares edits that same variable; one
   * the template never mentions is sent as an extra variable, which the
   * ich777-style images read all the same.
   */
  const gameSettings = detail.gameSettings ?? [];
  const connectKeys = new Set(gameSettings.map((s) => s.key));
  const templateTargets = new Set(
    template.fields.filter((f) => f.type === 'Variable').map((f) => f.target),
  );
  const [connectValues, setConnectValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (detail.gameSettings ?? []).map((s) => [
        s.key,
        template.fields.find((f) => f.type === 'Variable' && f.target === s.key)?.value ?? '',
      ]),
    ),
  );

  const variables = template.fields.filter(
    (f) => f.type === 'Variable' && !connectKeys.has(f.target),
  );
  const portFields = template.fields.filter((f) => f.type === 'Port');
  const paths = template.fields.filter((f) => f.type === 'Path');

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      const connectAsVariables: Record<string, string> = {};
      const connectAsExtra: Array<{ name: string; value: string }> = [];
      for (const spec of gameSettings) {
        const value = (connectValues[spec.key] ?? '').trim();
        // A template-declared variable is always sent, so clearing the field
        // means "no password" rather than silently keeping the default.
        if (templateTargets.has(spec.key)) connectAsVariables[spec.key] = value;
        else if (value) connectAsExtra.push({ name: spec.key, value });
      }
      const result = await api.deploy({
        appId: app.id,
        name,
        acknowledge: Boolean(review?.needsAcknowledgement),
        extra: { ...extra, variables: [...extra.variables, ...connectAsExtra] },
        variables: { ...values, ...connectAsVariables },
        ports: Object.fromEntries(
          Object.entries(ports).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v)),
        ) as Record<string, number>,
      });
      setDone({ serverId: result.serverId, appdataPath: result.appdataPath });
    } catch (err) {
      // A refusal carries the findings that caused it, so the reason lands on
      // screen rather than a bare "failed". A 428 is not a refusal: the new
      // warnings (an empty password, say) land in the list, and the next
      // press deploys acknowledged.
      if (err instanceof ApiError && Array.isArray(err.body.findings)) {
        const findings = err.body.findings as Finding[];
        const needsAck = err.body.error === 'needs-acknowledgement';
        setReview((prev) =>
          prev
            ? { ...prev, findings, deployable: needsAck, needsAcknowledgement: needsAck }
            : prev,
        );
      }
      setError(
        err instanceof ApiError && err.body.error === 'needs-acknowledgement'
          ? 'Check the warnings above — press deploy again to proceed anyway.'
          : err instanceof ApiError && typeof err.body.message === 'string'
            ? err.body.message
            : err instanceof ApiError && err.body.error === 'refused'
              ? 'Refused — see the checks above.'
              : 'The deployment failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>{name} is running</h2>
        </div>
        <p className="notes">
          Data directory: <code>{done.appdataPath}</code>
        </p>
        <p className="notes">
          The first start downloads the game, which can take a long time. It will show as offline
          until that finishes.
        </p>
        <div className="actions">
          <button type="button" className="btn-primary" onClick={() => navigate(`/servers/${done.serverId}`)}>
            Open {name}
          </button>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Add another
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <button type="button" className="backlink" onClick={onCancel}>
        ← Back to the catalogue
      </button>

      <div className="page-head">
        <h1>{app.name}</h1>
        <p>
          {app.repository} · from {app.publisher}
        </p>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Name</h2>
        </div>
        <label className="field">
          <span>Container and server name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {portFields.length > 0 ? (
          <>
            <div className="card-head">
              <h2>Ports</h2>
            </div>
            {portFields.map((f) => (
              <label className="field" key={f.target}>
                <span>
                  {f.name} ({f.mode || 'tcp'}, container {f.target})
                </span>
                <input
                  value={ports[f.target] ?? ''}
                  inputMode="numeric"
                  onChange={(e) => setPorts((p) => ({ ...p, [f.target]: e.target.value }))}
                />
              </label>
            ))}
          </>
        ) : null}

        {gameSettings.length > 0 ? (
          <>
            <div className="card-head">
              <h2>Joining</h2>
            </div>
            <p className="notes">
              What friends need to get in. Set it here and it is ready the moment the server is —
              everything can still be changed later on the Settings tab.
            </p>
            {gameSettings.map((spec) => (
              <label className="field" key={spec.key}>
                <span>
                  {spec.label}
                  {spec.help ? ` — ${spec.help}` : ''}
                </span>
                <input
                  value={connectValues[spec.key] ?? ''}
                  autoComplete="off"
                  onChange={(e) => {
                    setConnectValues((v) => ({ ...v, [spec.key]: e.target.value }));
                    // Editing a value withdraws its verdict: the preflight
                    // judges the new value on the next deploy press, and a
                    // fixed field must never leave the button dead.
                    setReview((prev) => {
                      if (!prev) return prev;
                      const findings = prev.findings.filter(
                        (f) => !f.id.startsWith('setting-') && f.id !== 'no-password' && f.id !== 'no-admin-password',
                      );
                      return {
                        ...prev,
                        findings,
                        deployable: !findings.some((f) => f.state === 'fail'),
                      };
                    });
                  }}
                />
              </label>
            ))}
          </>
        ) : null}

        {variables.length > 0 ? (
          <>
            <div className="card-head">
              <h2>Settings</h2>
            </div>
            {variables.map((f) => (
              <label className="field" key={f.target}>
                <span>
                  {f.name}
                  {f.required ? ' *' : ''}
                  {f.description ? ` — ${f.description}` : ''}
                </span>
                <input
                  type={f.masked ? 'password' : 'text'}
                  value={values[f.target] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.target]: e.target.value }))}
                />
              </label>
            ))}
          </>
        ) : null}

        <p className="notes">
          {paths.length} data folder{paths.length === 1 ? '' : 's'} will be created under this
          server's own directory. Host paths from the template are ignored on purpose.
        </p>


        {/* The same three kinds Unraid's own template editor offers. Paths
            take a container path and a folder name rather than a host path,
            so every mount still lands inside this server's own directory. */}
        <details className="connect">
          <summary>
            Add your own variables, ports or folders
            {extraCount > 0 ? ` (${extraCount})` : ''}
          </summary>

          <h4 className="subhead">Variables</h4>
          {extra.variables.map((row, i) => (
            <div className="seedrow" key={`v${i}`}>
              <input
                className="modsearch"
                value={row.name}
                placeholder="SERVER_NAME"
                onChange={(e) => editExtra('variables', i, { name: e.target.value })}
              />
              <input
                className="modsearch"
                value={row.value}
                placeholder="value"
                onChange={(e) => editExtra('variables', i, { value: e.target.value })}
              />
              <button
                type="button"
                className="btn-ghost small danger"
                onClick={() => dropExtra('variables', i)}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => addExtra('variables', { name: '', value: '' })}
          >
            + Variable
          </button>

          <h4 className="subhead">Ports</h4>
          {extra.ports.map((row, i) => (
            <div className="seedrow" key={`p${i}`}>
              <input
                className="modsearch"
                value={row.container || ''}
                placeholder="container port"
                inputMode="numeric"
                onChange={(e) => editExtra('ports', i, { container: Number(e.target.value) || 0 })}
              />
              <input
                className="modsearch"
                value={row.host || ''}
                placeholder="host port"
                inputMode="numeric"
                onChange={(e) => editExtra('ports', i, { host: Number(e.target.value) || 0 })}
              />
              <select
                className="rolepick"
                value={row.protocol}
                onChange={(e) =>
                  editExtra('ports', i, { protocol: e.target.value as 'tcp' | 'udp' })
                }
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <button
                type="button"
                className="btn-ghost small danger"
                onClick={() => dropExtra('ports', i)}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => addExtra('ports', { container: 0, host: 0, protocol: 'tcp' })}
          >
            + Port
          </button>

          <h4 className="subhead">Folders</h4>
          {extra.paths.map((row, i) => (
            <div className="seedrow" key={`d${i}`}>
              <input
                className="modsearch"
                value={row.container}
                placeholder="/path/inside/the/container"
                onChange={(e) => editExtra('paths', i, { container: e.target.value })}
              />
              <input
                className="modsearch"
                value={row.name}
                placeholder="folder name (optional)"
                onChange={(e) => editExtra('paths', i, { name: e.target.value })}
              />
              <button
                type="button"
                className="btn-ghost small danger"
                onClick={() => dropExtra('paths', i)}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => addExtra('paths', { container: '', name: '' })}
          >
            + Folder
          </button>

          <p className="hint">
            A folder is created inside this server's own directory and mounted at the container
            path you give. There is no field for a host path on purpose: every mount staying
            inside that directory is what stops a deployed server reaching the rest of the
            machine.
          </p>
        </details>
        <h3 className="subhead">Before you deploy</h3>
        {reviewError ? <p className="hint bad">{reviewError}</p> : null}
        {!review && !reviewError ? <p className="empty">Checking this app…</p> : null}
        {review ? (
          <>
            <Findings findings={review.findings} />
            {review.image?.digest ? (
              <p className="plan-hash">
                image <code>{review.image.digest}</code>
              </p>
            ) : null}
          </>
        ) : null}

        {error ? <p className="hint bad">{error}</p> : null}

        <div className="actions">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name || (review ? !review.deployable : false)}
            onClick={() => void deploy()}
          >
            {busy
              ? 'Deploying…'
              : review && !review.deployable
                ? 'Cannot deploy'
                : review?.needsAcknowledgement
                  ? `Deploy ${app.name} anyway`
                  : `Deploy ${app.name}`}
          </button>
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </section>
    </>
  );
}
