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
  const num = (value, max) => Math.min(Math.max(Number(value) || 0, 0), max);
  const version = String(body.version ?? '').slice(0, 32);
  const platform = String(body.platform ?? '').slice(0, 32);
  const servers = num(body.servers, 1000);
  const serversRunning = Math.min(num(body.serversRunning, 1000), servers);
  const players = num(body.players, 100_000);
  const playersPeak = Math.max(num(body.playersPeak24h, 100_000), players);

  /** Both game maps take the same shape and the same clamps. */
  const countMap = (raw) => {
    const out = {};
    if (raw && typeof raw === 'object') {
      for (const [name, count] of Object.entries(raw).slice(0, 50)) {
        const n = Math.min(Math.max(Number(count) || 0, 0), 1000);
        if (n > 0) out[String(name).slice(0, 64)] = n;
      }
    }
    return out;
  };
  const games = countMap(body.games);
  const gamesWanted = countMap(body.gamesWanted);
  const features = {};
  if (body.features && typeof body.features === 'object') {
    for (const [name, value] of Object.entries(body.features).slice(0, 20)) {
      features[String(name).slice(0, 32)] = value === true;
    }
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO installs (install, version, platform, servers, servers_running, players,
                           players_peak, games, games_wanted, features, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT(install) DO UPDATE SET
       version = ?2, platform = ?3, servers = ?4, servers_running = ?5, players = ?6,
       players_peak = ?7, games = ?8, games_wanted = ?9, features = ?10, last_seen = ?11`,
  )
    .bind(
      install,
      version,
      platform,
      servers,
      serversRunning,
      players,
      playersPeak,
      JSON.stringify(games),
      JSON.stringify(gamesWanted),
      JSON.stringify(features),
      now,
    )
    .run();

  const day = new Date(now).toISOString().slice(0, 10);
  const active = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(servers), 0) AS s, COALESCE(SUM(players_peak), 0) AS p
     FROM installs WHERE last_seen > ?1`,
  )
    .bind(now - 48 * 3600_000)
    .first();
  await env.DB.prepare(
    `INSERT INTO daily (day, installs, servers, players_peak) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(day) DO UPDATE SET installs = ?2, servers = ?3, players_peak = ?4`,
  )
    .bind(day, active.n, active.s, active.p)
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
    `SELECT COUNT(*) AS installs, COALESCE(SUM(servers), 0) AS servers,
            COALESCE(SUM(servers_running), 0) AS running,
            COALESCE(SUM(players), 0) AS players,
            COALESCE(SUM(players_peak), 0) AS peak,
            COALESCE(MAX(last_seen), 0) AS last_ping,
            SUM(CASE WHEN last_seen > ?2 THEN 1 ELSE 0 END) AS pings_today
     FROM installs WHERE last_seen > ?1`,
  )
    .bind(cutoff, Date.now() - 24 * 3600_000)
    .first();

  const rows = (
    await env.DB.prepare('SELECT games, games_wanted, version, platform, features FROM installs WHERE last_seen > ?1')
      .bind(cutoff)
      .all()
  ).results;

  const games = {};
  const wanted = {};
  /*
   * "Unknown" is not a game anyone is waiting for: it is a server whose type
   * neither the registry nor GameDig's catalogue could put a name to. Listing
   * it as a bar called "Unknown" on the wish list told a reader nothing and
   * read like a bug. It is counted apart and written out as one sentence.
   */
  let unnamed = 0;
  const versions = {};
  const platforms = {};
  const features = {};
  for (const row of rows) {
    try {
      for (const [name, count] of Object.entries(JSON.parse(row.games))) {
        // A portal older than the gamesWanted split still reports an
        // unrecognised game as "Unknown" inside games, so the same rule has to
        // hold for both shapes until everyone has upgraded.
        if (name === 'Unknown') unnamed += Number(count);
        else games[name] = (games[name] ?? 0) + Number(count);
      }
    } catch {
      /* a malformed stored row counts as nothing */
    }
    try {
      for (const [name, count] of Object.entries(JSON.parse(row.games_wanted ?? '{}'))) {
        if (name === 'Unknown') unnamed += Number(count);
        else wanted[name] = (wanted[name] ?? 0) + Number(count);
      }
    } catch {
      /* same */
    }
    try {
      for (const [name, on] of Object.entries(JSON.parse(row.features))) {
        if (on === true) features[name] = (features[name] ?? 0) + 1;
      }
    } catch {
      /* same */
    }
    versions[row.version] = (versions[row.version] ?? 0) + 1;
    platforms[row.platform] = (platforms[row.platform] ?? 0) + 1;
  }

  const history = (
    await env.DB.prepare(
      'SELECT day, installs, servers, players_peak FROM daily ORDER BY day DESC LIMIT 60',
    ).all()
  ).results.reverse();

  const top = (obj, n = 25) =>
    Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n);

  return {
    generatedAt: new Date().toISOString(),
    activeInstalls: totals.installs,
    activeServers: totals.servers,
    serversRunning: totals.running,
    playersNow: totals.players,
    playersPeak: totals.peak,
    // What makes a page feel live rather than printed: when the last ping
    // landed, and how many arrived in the last day.
    lastPingAt: Number(totals.last_ping) || null,
    pingsToday: Number(totals.pings_today) || 0,
    games: top(games),
    gamesWanted: top(wanted, 12),
    gamesUnnamed: unnamed,
    versions: top(versions),
    platforms: top(platforms),
    features: top(features),
    history,
  };
}

/* ── charts ──────────────────────────────────────────────────────────────
 * Hand-rolled inline SVG: a worker ships no chart library, and these three
 * forms need none. The palette is validated for the dark surface (#121a30):
 * violet, aqua, yellow, blue — worst adjacent CVD ΔE 8.4, normal-vision 19.8.
 * Every form also carries its value as text, so colour is never the only
 * channel and a screen reader gets the numbers.
 */
const CATEGORICAL = ['#9085e9', '#199e70', '#c98500', '#3987e5'];
const SERIES = '#9085e9';

/** Horizontal bars for magnitude: one hue, length is the whole message. */
function barChart(rows, esc) {
  if (rows.length === 0) return '<p class="empty">Nothing yet — the numbers appear as installs opt in.</p>';
  const max = Math.max(...rows.map(([, v]) => v), 1);
  return rows
    .map(
      ([name, value]) => `<div class="row">
        <span class="name">${esc(name)}</span>
        <span class="track"><span class="bar" style="width:${Math.max(2, (value / max) * 100)}%"></span></span>
        <span class="n">${esc(value)}</span>
      </div>`,
    )
    .join('');
}

/**
 * Counts at identity, not magnitude.
 *
 * Every GameKeepr install runs one or two of a given game, so a bar chart of
 * games is six bars of identical length: a shape that looks like data and
 * carries none. A board of tiles says the same thing honestly — which games
 * are out there, how many of each — and stays readable whether that is six
 * games or sixty.
 */
function chipBoard(rows, esc) {
  if (rows.length === 0) return '<p class="empty">Nothing yet — the numbers appear as installs opt in.</p>';
  return `<div class="board">${rows
    .map(
      ([name, value]) => `<div class="chip">
        <span class="cname">${esc(name)}</span>
        <span class="cn">${esc(value)}</span>
      </div>`,
    )
    .join('')}</div>`;
}

/**
 * The shape of a number, beside the number. No axis, no labels: a sparkline
 * answers "which way is this going" and leaves the value to the tile.
 */
function sparkline(history, pick) {
  const points = history.filter((h) => Number.isFinite(Number(h[pick])));
  if (points.length < 3) return '';
  const W = 120;
  const H = 30;
  const max = Math.max(...points.map((p) => Number(p[pick])), 1);
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => H - (Number(v) / max) * (H - 6) - 3;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[pick]).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line}" fill="none" stroke="${SERIES}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" opacity="0.85"></path>
  </svg>`;
}

/**
 * Movement over the last week, as text.
 *
 * Shown only when there is a week to compare against: inventing a trend from
 * two days of history would be the kind of confident nonsense this project
 * exists not to do.
 */
function trendNote(history, pick, esc) {
  const points = history.filter((h) => Number.isFinite(Number(h[pick])));
  if (points.length < 8) return '';
  const now = Number(points[points.length - 1][pick]);
  const then = Number(points[points.length - 8][pick]);
  const delta = now - then;
  if (delta === 0) return '<span class="delta flat">level this week</span>';
  const sign = delta > 0 ? '+' : '−';
  return `<span class="delta ${delta > 0 ? 'up' : 'down'}">${sign}${esc(Math.abs(delta))} this week</span>`;
}

/** "14 minutes ago" — computed server-side so the page is right without JS. */
function ago(ms) {
  if (!ms) return 'no pings yet';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * A donut, used only where it is honest: part-to-whole at a glance with at
 * most a handful of segments. Platforms qualify; games (dozens) do not and
 * stay a bar chart. Segments carry a 2px surface gap and a labelled legend.
 */
function donutChart(rows, esc) {
  if (rows.length === 0) return '<p class="empty">Nothing yet.</p>';
  const slices = rows.slice(0, 4);
  const rest = rows.slice(4).reduce((sum, [, v]) => sum + v, 0);
  if (rest > 0) slices.push(['Other', rest]);
  const total = slices.reduce((sum, [, v]) => sum + v, 0) || 1;

  const R = 56;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const ring = slices
    .map(([, value], i) => {
      const len = (value / total) * C;
      // The 2px gap between fills: a hairline of surface, never a hard join.
      const dash = `${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}`;
      const circle = `<circle class="seg" r="${R}" cx="80" cy="80" fill="none"
        stroke="${CATEGORICAL[i % CATEGORICAL.length]}" stroke-width="18"
        stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"></circle>`;
      offset += len;
      return circle;
    })
    .join('');

  const legend = slices
    .map(
      ([name, value], i) =>
        `<li><span class="swatch" style="background:${CATEGORICAL[i % CATEGORICAL.length]}"></span>
          <span class="lname">${esc(name)}</span>
          <span class="n">${esc(value)} · ${Math.round((value / total) * 100)}%</span></li>`,
    )
    .join('');

  return `<div class="donutwrap">
    <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="Platforms by share of installs">
      <g transform="rotate(-90 80 80)">${ring}</g>
      <text x="80" y="76" class="dcount">${esc(total)}</text>
      <text x="80" y="94" class="dlabel">installs</text>
    </svg>
    <ul class="legend">${legend}</ul>
  </div>`;
}

/** One series over time: an area, no legend — the heading names it. */
function areaChart(history, pick, esc) {
  const points = history.filter((h) => Number.isFinite(Number(h[pick])));
  if (points.length < 2) {
    return '<p class="empty">A few more days of pings and the trend appears here.</p>';
  }
  const W = 640;
  const H = 120;
  const max = Math.max(...points.map((p) => Number(p[pick])), 1);
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => H - (Number(v) / max) * (H - 12) - 6;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[pick]).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = points[points.length - 1];
  const day = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  // The gradient id is derived from the series: two charts on one page with
  // the same id is a collision waiting for the day the colours differ.
  const fade = `fade-${String(pick).replace(/[^a-z0-9]/gi, '')}`;
  return `<svg class="area" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Trend over the last ${points.length} days, now ${esc(last[pick])}">
    <path d="${area}" fill="url(#${fade})"></path>
    <path d="${line}" fill="none" stroke="${SERIES}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>
    <defs><linearGradient id="${fade}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${SERIES}" stop-opacity="0.28"></stop>
      <stop offset="100%" stop-color="${SERIES}" stop-opacity="0"></stop>
    </linearGradient></defs>
  </svg>
  <p class="axis"><span>${esc(day(points[0].day))}</span><span>${esc(day(last.day))} · ${esc(last[pick])}</span></p>`;
}

async function statsJson(env) {
  return new Response(JSON.stringify(await aggregates(env), null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}

const FEATURE_LABELS = {
  tournaments: 'Tournaments',
  schedules: 'Schedules',
  validationRuns: 'Validation runs',
  backups: 'Backups',
  mods: 'Mods',
  notifications: 'Discord notifications',
  router: 'Router integration',
};

async function statsPage(env) {
  const data = await aggregates(env);
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /*
   * The portal's own look, token for token — the same theme layer the public
   * tournament page wears, so this page is unmistakably the same product.
   * The logo comes from jsDelivr because that is public; this worker has no
   * access to anything behind the portal's door, by construction.
   */
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>GameKeepr — public statistics</title>
<link rel="icon" href="https://cdn.jsdelivr.net/gh/KenGoossens/Gamekeep@main/web/public/logo.png" />
<style>
:root {
  --bg: #090e1c; --surface: #121a30; --surface-2: #1a2440;
  --border: #273252; --border-soft: #1d2740;
  --text: #eef1f8; --muted: #9aa5c4; --faint: #6b779c;
  --accent: #7c6cf2; --accent-cyan: #49c9f7;
  --ok: #4ade80; --gold: #e8b44c; --radius: 16px;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text); min-height: 100vh;
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* The portal's grid backdrop: hairlines fading out, plus a soft glow. */
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1;
  background:
    radial-gradient(900px 480px at 75% -10%, rgba(124, 108, 242, 0.14), transparent 65%),
    radial-gradient(700px 420px at 15% 0%, rgba(73, 201, 247, 0.07), transparent 60%),
    repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 44px),
    repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 44px);
  mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 95%);
}
main { max-width: 960px; margin: 0 auto; padding: 22px 20px 60px; }
.brand {
  display: flex; align-items: center; gap: 10px; margin-bottom: 26px;
  color: var(--muted); font-weight: 650; font-size: 0.95rem;
}
.brand img { width: 26px; height: 26px; }
h1 { margin: 0; font-size: 1.7rem; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 6px 0 26px; }
/* 150px, not 190: on a phone that is the difference between four tiles in a
   column and a 2×2 board you can take in at once. */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 8px; }
.tile {
  background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: var(--radius); padding: 16px 18px;
}
.tile b { display: block; font-size: 2rem; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.tile span { color: var(--faint); font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 650; }
.tile .spark { display: block; width: 100%; height: 30px; margin-top: 10px; }
.tile .delta, .tile .note {
  display: block; margin-top: 6px; text-transform: none; letter-spacing: 0;
  font-size: 0.78rem; font-weight: 500;
}
.tile .delta.up { color: var(--ok); }
.tile .delta.down { color: var(--gold); }
.tile .delta.flat, .tile .note { color: var(--faint); }

/* The status strip: the line that says this page is listening, not printed. */
.statusbar {
  display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center;
  margin: -14px 0 18px; padding: 10px 16px;
  background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: 12px; color: var(--faint); font-size: 0.82rem;
}
.statusbar b { color: var(--text); font-weight: 650; font-variant-numeric: tabular-nums; }
.snapshot { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-weight: 650;
  text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.72rem; }
.snapshot i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }

/* The fleet board: identity and a count, dense enough to scan. */
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 8px; }
.chip {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  background: var(--surface-2); border: 1px solid var(--border-soft);
}
.chip .cname { color: var(--text); font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .cn {
  color: var(--muted); font-size: 0.82rem; font-variant-numeric: tabular-nums;
  background: rgba(144, 133, 233, 0.16); border-radius: 999px; padding: 1px 9px; flex: none;
}
h2 { font-size: 1.02rem; margin: 30px 0 10px; }
.card {
  background: var(--surface); border: 1px solid var(--border-soft);
  border-radius: var(--radius); padding: 14px 18px;
}
/* Charts: thin marks, rounded data-ends, recessive everything else. */
.row { display: flex; align-items: center; gap: 12px; margin: 9px 0; }
.row .name { width: 200px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .track { flex: 1; min-width: 60px; }
.row .bar { display: block; height: 10px; border-radius: 5px; background: #9085e9; }
.row .n { width: 46px; text-align: right; color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.empty { color: var(--faint); margin: 4px 0; }
.footnote { color: var(--faint); font-size: 0.84rem; margin: 8px 2px 0; max-width: 62rem; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.donutwrap { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.donutwrap .seg { stroke-linecap: butt; }
.dcount { fill: var(--text); font-size: 26px; font-weight: 700; text-anchor: middle; }
.dlabel { fill: var(--faint); font-size: 10px; text-anchor: middle; text-transform: uppercase; letter-spacing: 0.08em; }
.legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 170px; }
.legend li { display: flex; align-items: center; gap: 9px; margin: 7px 0; }
.legend .swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.legend .lname { flex: 1; color: var(--muted); }
.legend .n { color: var(--faint); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.area { width: 100%; height: 120px; display: block; }
.axis { display: flex; justify-content: space-between; color: var(--faint); font-size: 0.78rem; margin: 6px 0 0; }
footer {
  margin-top: 44px; color: var(--faint); font-size: 0.84rem;
  border-top: 1px solid var(--border-soft); padding-top: 16px;
}
footer a { color: var(--muted); }
</style>
</head>
<body><main>
<div class="brand"><img src="https://cdn.jsdelivr.net/gh/KenGoossens/Gamekeep@main/web/public/logo.png" alt="" width="26" height="26" /> GameKeepr</div>
<h1>Public statistics</h1>
<p class="sub">From opt-in, anonymous daily pings. Everyone sees this page — the people sharing the
numbers included. A portal reports once a day, so every number below is the sum of each install's
<em>most recent</em> report, counting the ones that reported in the last 48 hours. Page rebuilt
<time datetime="${esc(data.generatedAt)}">${esc(
    new Date(data.generatedAt).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }),
  )} UTC</time>.</p>

<!--
  Not "live", and the dot does not pulse. A portal reports once a day, so every
  number here is the sum of each install's most recent report -- some of them
  nearly two days old. Dressing that up as a live feed would be the one dishonest
  thing on a page whose entire argument is that it tells you exactly what it knows.
-->
<div class="statusbar">
  <span class="snapshot"><i></i> Daily snapshot</span>
  <span>Newest report <b>${esc(ago(data.lastPingAt))}</b></span>
  <span><b>${esc(data.pingsToday)}</b> install${data.pingsToday === 1 ? '' : 's'} reported in the last 24 h</span>
  <span><b>${esc(data.history.length)}</b> day${data.history.length === 1 ? '' : 's'} of history</span>
</div>

<div class="tiles">
  <div class="tile">
    <b>${esc(data.activeInstalls)}</b><span>active installs</span>
    ${sparkline(data.history, 'installs')}${trendNote(data.history, 'installs', esc)}
  </div>
  <div class="tile">
    <b>${esc(data.activeServers)}</b><span>game servers watched</span>
    ${sparkline(data.history, 'servers')}${trendNote(data.history, 'servers', esc)}
  </div>
  <div class="tile">
    <b>${esc(data.serversRunning)}</b><span>servers up at last report</span>
    <span class="note">of ${esc(data.activeServers)} watched · not a live count</span>
  </div>
  <div class="tile">
    <b>${esc(data.playersPeak)}</b><span>players at the daily peak</span>
    <span class="note">each portal's busiest minute, summed</span>
    ${sparkline(data.history, 'players_peak')}${trendNote(data.history, 'players_peak', esc)}
  </div>
</div>

<h2>Games people run</h2>
<div class="card">${chipBoard(data.games, esc)}</div>
${
  data.gamesUnnamed === 0
    ? ''
    : `<p class="footnote">Plus ${esc(data.gamesUnnamed)} server${data.gamesUnnamed === 1 ? '' : 's'} running
something neither GameKeepr's registry nor GameDig's public catalogue could put a name to. A game is
only ever named here when it appears in that catalogue, so a hand-written type stays unnamed by
design rather than leaking out as text.</p>`
}
${
  data.gamesWanted.length === 0
    ? ''
    : `<h2>Most wanted</h2>
<p class="sub">Games people already run on GameKeepr that its registry does not fully know yet —
named from GameDig's public catalogue. These are the ones worth supporting next.</p>
<div class="card">${chipBoard(data.gamesWanted, esc)}</div>`
}

<div class="two">
  <div>
    <h2>Where it runs</h2>
    <div class="card">${donutChart(data.platforms, esc)}</div>
  </div>
  <div>
    <h2>Features in use</h2>
    <div class="card">${barChart(
      data.features.map(([key, count]) => [FEATURE_LABELS[key] ?? key, count]),
      esc,
    )}</div>
  </div>
</div>

<div class="two">
  <div>
    <h2>Installs over time</h2>
    <div class="card">${areaChart(data.history, 'installs', esc)}</div>
  </div>
  <div>
    <h2>Players at the daily peak</h2>
    <div class="card">${areaChart(data.history, 'players_peak', esc)}</div>
  </div>
</div>

<h2>Versions in use</h2>
<p class="sub">Which release people are actually running — the honest measure of whether an update
reached anyone.</p>
<div class="card">${barChart(data.versions, esc)}</div>
<footer>Raw aggregates: <a href="/stats.json">stats.json</a> ·
What a ping contains, line by line: <a href="https://kengoossens.github.io/Gamekeep/wiki/security.html">the GameKeepr wiki</a> ·
This page's code is in <a href="https://github.com/KenGoossens/Gamekeep/tree/main/mothership">the open repository</a> ·
Run with <a href="https://kengoossens.github.io/Gamekeep/">GameKeepr</a>, the self-hosted game server portal.</footer>
</main>
<script>
// The page renders a readable UTC time server-side, so it is right with or
// without scripting; this upgrades it to the reader's own clock.
(function () {
  var el = document.querySelector('time[datetime]');
  if (!el) return;
  var when = new Date(el.getAttribute('datetime'));
  if (isNaN(when.getTime())) return;
  el.textContent = when.toLocaleString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  el.title = 'Your local time';
})();
</script>
</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
