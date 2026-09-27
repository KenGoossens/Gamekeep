import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type CatalogApp, type CatalogTemplate } from '../api.ts';
import { navigate } from '../router.ts';

export function CatalogPage() {
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
          {total} game servers from trusted publishers in Community Applications. Deploying creates
          a container on your Unraid server.
        </p>
      </div>

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

  const variables = template.fields.filter((f) => f.type === 'Variable');
  const portFields = template.fields.filter((f) => f.type === 'Port');
  const paths = template.fields.filter((f) => f.type === 'Path');

  async function deploy() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deploy({
        appId: app.id,
        name,
        variables: values,
        ports: Object.fromEntries(
          Object.entries(ports).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v)),
        ) as Record<string, number>,
      });
      setDone({ serverId: result.serverId, appdataPath: result.appdataPath });
    } catch (err) {
      setError(
        err instanceof ApiError && typeof err.body.message === 'string'
          ? err.body.message
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

        {error ? <p className="hint bad">{error}</p> : null}

        <div className="actions">
          <button type="button" className="btn-primary" disabled={busy || !name} onClick={() => void deploy()}>
            {busy ? 'Deploying…' : `Deploy ${app.name}`}
          </button>
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </section>
    </>
  );
}
