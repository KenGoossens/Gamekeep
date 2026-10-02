/**
 * Builds the public documentation site in docs/ from the wiki's own sources.
 *
 * One source of truth: the same markdown the portal serves behind sign-in is
 * rendered here as a static site for GitHub Pages, so the public wiki can
 * never drift from the real one. The portal's RBAC does not apply to the
 * public copy on purpose -- the pages document an open-source product, not
 * anyone's particular installation.
 *
 * Run from the repository root:  cd server && npx tsx ../scripts/build-docs.mts
 * Re-run whenever a wiki page or screenshot changes, and commit docs/.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIKI_PAGES } from '../server/src/wiki/index.js';
import { renderMarkdown } from '../web/src/markdown.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const pagesDir = join(root, 'server/src/wiki/pages');
const imagesDir = join(root, 'server/src/wiki/images');

const GITHUB = 'https://github.com/KenGoossens/Gamekeep';

/*
 * docs/ serves two masters: GitHub Pages reads the generated site from it,
 * and docs/adr/ holds the architecture decision records, which are sources,
 * not output. So the wipe is selective — deleting the whole directory is how
 * ADR-0001 briefly vanished from history.
 */
for (const generated of ['wiki', 'images', 'index.html', 'changelog.html', 'style.css', '.nojekyll']) {
  rmSync(join(docs, generated), { recursive: true, force: true });
}
mkdirSync(join(docs, 'wiki'), { recursive: true });
// GitHub Pages must not run this through Jekyll; it is already HTML.
writeFileSync(join(docs, '.nojekyll'), '');
cpSync(imagesDir, join(docs, 'images'), { recursive: true });
cpSync(join(root, 'web/public/logo.png'), join(docs, 'images/logo.png'));

const css = readFileSync(join(root, 'scripts/docs.css'), 'utf8');
writeFileSync(join(docs, 'style.css'), css);

/** The shared chrome around every page of the site. */
function shell(title: string, body: string, depth: 0 | 1): string {
  const base = depth === 1 ? '../' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${title}</title>
<meta name="description" content="GameKeepr — the self-hosted game server portal for your friends. Restart, schedule, back up and mod game servers on your own machine." />
<link rel="icon" href="${base}images/logo.png" />
<link rel="stylesheet" href="${base}style.css" />
</head>
<body>
<header class="top">
  <a class="brand" href="${base}index.html"><img src="${base}images/logo.png" alt="" /> GameKeepr</a>
  <nav>
    <a href="${base}wiki/welcome.html">Wiki</a>
    <a href="${base}changelog.html">Changelog</a>
    <a href="${GITHUB}">GitHub</a>
  </nav>
</header>
${body}
<footer>
  <p>GameKeepr is open source. <a href="${GITHUB}">Source, issues and releases on GitHub</a>.</p>
</footer>
</body>
</html>
`;
}

// ---- the wiki pages --------------------------------------------------------

const sections: Array<{ section: string; pages: Array<{ id: string; title: string }> }> = [];
for (const page of WIKI_PAGES) {
  let bucket = sections.find((s) => s.section === page.section);
  if (!bucket) sections.push((bucket = { section: page.section, pages: [] }));
  bucket.pages.push({ id: page.id, title: page.title });
}

function sidebar(activeId: string): string {
  return `<nav class="side">${sections
    .map(
      (s) =>
        `<h3>${s.section}</h3><ul>${s.pages
          .map(
            (p) =>
              `<li><a href="${p.id}.html"${p.id === activeId ? ' class="active"' : ''}>${p.title}</a></li>`,
          )
          .join('')}</ul>`,
    )
    .join('')}</nav>`;
}

for (const page of WIKI_PAGES) {
  const markdown = readFileSync(join(pagesDir, `${page.id}.md`), 'utf8')
    // The portal serves images behind sign-in; the public site serves them flat.
    .replaceAll('/api/wiki/images/', '../images/');
  const html = renderMarkdown(markdown);
  writeFileSync(
    join(docs, 'wiki', `${page.id}.html`),
    shell(
      `${page.title} — GameKeepr`,
      `<div class="wiki">${sidebar(page.id)}<article class="prose">${html}</article></div>`,
      1,
    ),
  );
}

// ---- the changelog ---------------------------------------------------------
// The same CHANGELOG.md that lives in the repository, rendered as a page, so
// "what changed" has a link people can be given rather than a file to find.

const changelog = renderMarkdown(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));
writeFileSync(
  join(docs, 'changelog.html'),
  shell('Changelog — GameKeepr', `<main class="wiki"><article class="prose">${changelog}</article></main>`, 0),
);

// ---- the landing page ------------------------------------------------------

const landing = `
<main class="hero">
  <h1>Your game servers, <em>your friends' hands</em>.</h1>
  <p class="tag">
    GameKeepr is a self-hosted portal for the game servers on your own machine. Friends sign in,
    see who is playing, and restart a server when a game update lands — without touching Unraid,
    SSH, or anything else on the box.
  </p>
  <p class="cta">
    <a class="btn" href="${GITHUB}">Get it on GitHub</a>
    <a class="btn ghost" href="wiki/welcome.html">Read the wiki</a>
  </p>
  <img class="shot" src="images/servers.png" alt="The Servers page: full-picture cards per game server" />
</main>

<section class="features">
  <div>
    <h2>Restarts that tell the truth</h2>
    <p>A restart is verified in two stages — the container came back, then the <strong>game itself
    answered</strong>. Per-game startup times, a cooldown that stops restart-hammering, and an
    activity feed everyone can read.</p>
  </div>
  <div>
    <h2>Any server Steam carries</h2>
    <p>Deploy from Unraid's Community Applications, or pick any of ~580 dedicated servers on Steam
    — GameKeepr composes the container itself on Valve's official steamcmd image, with the start
    command from Steam's own app info, shown before anything exists.</p>
  </div>
  <div>
    <h2>Schedules with manners</h2>
    <p>Nightly restarts that ask the game if anyone is playing first, never turn a deliberately
    stopped server back on, and skip missed runs instead of firing them late.</p>
  </div>
  <div>
    <h2>Backups of what matters</h2>
    <p>The world and its settings — not the reinstallable gigabytes. Restores only while stopped,
    always preceded by a safety copy, applied as an overlay.</p>
  </div>
  <div>
    <h2>Mods, checked honestly</h2>
    <p>Repository installs with hash verification, archive-safety judging and optional malware
    scanning; Steam Workshop declarations for the games that fetch their own. No report ever says
    "safe" — it says what was checked.</p>
  </div>
  <div>
    <h2>Three roles, per-server exceptions</h2>
    <p>Members restart, operators run servers, the owner runs the platform. Any user can be made
    operator of one server, member on another, or shown nothing at all — hidden means hidden.</p>
  </div>
</section>

<section class="gallery">
  <figure><img src="images/dashboard.png" alt="The dashboard" loading="lazy" /><figcaption>The command centre: is anything wrong?</figcaption></figure>
  <figure><img src="images/catalog-steam.png" alt="The Steam catalogue" loading="lazy" /><figcaption>Every dedicated server on Steam, recognised games first.</figcaption></figure>
  <figure><img src="images/logs-console.png" alt="Logs and console" loading="lazy" /><figcaption>Live logs, with a console that types at the game.</figcaption></figure>
</section>

<section class="quickstart">
  <h2>Run it</h2>
  <pre><code>mkdir gamekeepr && cd gamekeepr
curl -LO https://raw.githubusercontent.com/KenGoossens/Gamekeep/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/KenGoossens/Gamekeep/main/.env.example
# edit .env: PUBLIC_URL, SESSION_SECRET, TZ
docker compose up -d</code></pre>
  <p>On Unraid it is one search away: <strong>Apps → “GameKeepr” → Install</strong> —
  GameKeepr is in Community Applications.</p>
  <p>First boot prints a one-time setup token in the container log; open the portal and create the
  owner account with it. The
  <a href="wiki/setup.html">setup guide</a> walks through the rest — including the one honest
  warning: the portal holds the Docker socket, and the
  <a href="wiki/security.html">security model</a> explains what that means and what is done
  about it.</p>
</section>
`;

writeFileSync(join(docs, 'index.html'), shell('GameKeepr — self-hosted game server portal', landing, 0));

console.log(`docs/ gebouwd: index + ${WIKI_PAGES.length} wikipagina's + afbeeldingen`);
