/**
 * The GameKeepr mothership: receives the opt-in anonymous daily pings and
 * serves the public statistics page. This file is in the open repository on
 * purpose — anyone can read exactly what happens to a ping.
 *
 * What it deliberately does NOT do:
 * - It never reads or stores the caller's IP address.
 * - It never stores anything beyond the documented payload fields.
 * - It keeps raw per-install rows for 90 days of inactivity, then sweeps
 *   them; only the daily aggregate counts remain.
 */

const MAX_BODY_BYTES = 8 * 1024;
const SWEEP_AFTER_MS = 90 * 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/ping') return ping(request, env);
    if (request.method === 'GET' && url.pathname === '/stats.json') return statsJson(env);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/stats')) {
      return statsPage(env);
    }
    return new Response('not found', { status: 404 });
  },

  // Cron (configured in wrangler.toml): aggregate yesterday and sweep.
  async scheduled(_event, env) {
    await sweep(env);
  },
};

async function ping(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response('too large', { status: 413 });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // Validate hard: this is an open endpoint on the internet, and a stats page
  // fed by unvalidated input is a defacement waiting to happen.
  const install = String(body.install ?? '');
  if (!UUID.test(install)) return new Response('bad install id', { status: 400 });
  const version = String(body.version ?? '').slice(0, 32);
  const platform = String(body.platform ?? '').slice(0, 32);
  const servers = Math.min(Math.max(Number(body.servers) || 0, 0), 1000);

  const games = {};
  if (body.games && typeof body.games === 'object') {
    for (const [name, count] of Object.entries(body.games).slice(0, 50)) {
      const n = Math.min(Math.max(Number(count) || 0, 0), 1000);
      if (n > 0) games[String(name).slice(0, 64)] = n;
    }
  }
  const features = {};
  if (body.features && typeof body.features === 'object') {
    for (const [name, value] of Object.entries(body.features).slice(0, 20)) {
      features[String(name).slice(0, 32)] = value === true;
    }
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO installs (install, version, platform, servers, games, features, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(install) DO UPDATE SET
       version = ?2, platform = ?3, servers = ?4, games = ?5, features = ?6, last_seen = ?7`,
  )
    .bind(install, version, platform, servers, JSON.stringify(games), JSON.stringify(features), now)
    .run();

  const day = new Date(now).toISOString().slice(0, 10);
  const active = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(servers), 0) AS s FROM installs WHERE last_seen > ?1',
  )
    .bind(now - 48 * 3600_000)
    .first();
  await env.DB.prepare(
    `INSERT INTO daily (day, installs, servers) VALUES (?1, ?2, ?3)
     ON CONFLICT(day) DO UPDATE SET installs = ?2, servers = ?3`,
  )
    .bind(day, active.n, active.s)
    .run();

  return new Response('ok', { status: 200 });
}

async function sweep(env) {
  await env.DB.prepare('DELETE FROM installs WHERE last_seen < ?1')
    .bind(Date.now() - SWEEP_AFTER_MS)
    .run();
}

async function aggregates(env) {
  const cutoff = Date.now() - 48 * 3600_000;
  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS installs, COALESCE(SUM(servers), 0) AS servers FROM installs WHERE last_seen > ?1',
  )
    .bind(cutoff)
    .first();

  const rows = (
    await env.DB.prepare('SELECT games, version, platform FROM installs WHERE last_seen > ?1')
      .bind(cutoff)
      .all()
  ).results;

  const games = {};
  const versions = {};
  const platforms = {};
  for (const row of rows) {
    try {
      for (const [name, count] of Object.entries(JSON.parse(row.games))) {
        games[name] = (games[name] ?? 0) + Number(count);
      }
    } catch {
      /* a malformed stored row counts as nothing */
    }
    versions[row.version] = (versions[row.version] ?? 0) + 1;
    platforms[row.platform] = (platforms[row.platform] ?? 0) + 1;
  }

  const history = (
    await env.DB.prepare('SELECT day, installs, servers FROM daily ORDER BY day DESC LIMIT 60').all()
  ).results.reverse();

  const top = (obj) =>
    Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 25);

  return {
    generatedAt: new Date().toISOString(),
    activeInstalls: totals.installs,
    activeServers: totals.servers,
    games: top(games),
    versions: top(versions),
    platforms: top(platforms),
    history,
  };
}

async function statsJson(env) {
  return new Response(JSON.stringify(await aggregates(env), null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}

async function statsPage(env) {
  const data = await aggregates(env);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bar = (count, max) => Math.max(2, Math.round((count / Math.max(max, 1)) * 100));
  const maxGame = data.games[0]?.[1] ?? 1;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>GameKeepr — public statistics</title>
<style>
:root { --bg:#090e1c; --surface:#121a30; --border:#273252; --text:#eef1f8; --muted:#9aa5c4;
  --accent:#7c6cf2; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); min-height:100vh;
  font:15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
main { max-width:860px; margin:0 auto; padding:28px 20px 60px; }
h1 { font-size:1.6rem; margin:0 0 4px; }
.sub { color:var(--muted); margin:0 0 26px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px,1fr)); gap:12px; margin-bottom:26px; }
.tile { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px 18px; }
.tile b { display:block; font-size:1.9rem; }
.tile span { color:var(--muted); font-size:.85rem; }
h2 { font-size:1.02rem; margin:26px 0 10px; }
.row { display:flex; align-items:center; gap:10px; margin:5px 0; }
.row .name { width:220px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row .bar { height:10px; border-radius:5px; background:var(--accent); }
.row .n { color:var(--muted); font-size:.85rem; }
footer { margin-top:40px; color:var(--muted); font-size:.84rem; border-top:1px solid var(--border); padding-top:14px; }
footer a { color:var(--muted); }
</style>
</head>
<body><main>
<h1>GameKeepr — public statistics</h1>
<p class="sub">From opt-in, anonymous daily pings. Everyone sees this page — the people sharing the
numbers included. Counting installs active in the last 48 hours. Updated ${esc(data.generatedAt)}.</p>
<div class="tiles">
  <div class="tile"><b>${esc(data.activeInstalls)}</b><span>active installs</span></div>
  <div class="tile"><b>${esc(data.activeServers)}</b><span>game servers watched</span></div>
  <div class="tile"><b>${esc(data.games.length)}</b><span>different games</span></div>
</div>
<h2>Games people run</h2>
${data.games
  .map(
    ([name, count]) =>
      `<div class="row"><span class="name">${esc(name)}</span><span class="bar" style="width:${bar(count, maxGame)}px"></span><span class="n">${esc(count)}</span></div>`,
  )
  .join('')}
<h2>Versions</h2>
${data.versions
  .map(([name, count]) => `<div class="row"><span class="name">${esc(name)}</span><span class="n">${esc(count)} installs</span></div>`)
  .join('')}
<footer>Raw aggregates: <a href="/stats.json">stats.json</a> ·
What a ping contains, line by line: <a href="https://kengoossens.github.io/Gamekeep/wiki/security.html">the GameKeepr wiki</a> ·
This page's code is in <a href="https://github.com/KenGoossens/Gamekeep/tree/main/mothership">the open repository</a>.</footer>
</main></body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
