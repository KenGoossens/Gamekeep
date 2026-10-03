# Changelog

## Unreleased

### Added

- **Tournaments for any game.** The game picker now offers
  games where team-vs-team is real (Minecraft, V Rising, Palworld, Terraria)
  next to Counter-Strike 2, plus a free "Other game…" field for any contest.
  CS2 keeps its automatic flavour (a
  server per match, results from the game); every other game plays wherever
  you play and the organizer records results through Decide — bracket,
  seeding, scheduling, standings and the public page are identical. Maps are
  optional for non-CS2 tournaments, and the card wears the chosen game's
  poster.

All notable changes to GameKeepr. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org). The `latest` image on ghcr.io moves
only when a version is released; `edge` tracks the main branch between
releases.

## 1.2.1 — 2026-10-03

### Security

Findings from a full adversarial review (three independent passes:
authorization/injection, secrets/exposure, memory/lifecycles). No SQL
injection, no XSS and no authorization bypasses were found; these are the
hardenings that came out of it:

- **Match webhook payloads are clamped.** A compromised match server could
  send `map_number: 100000000` and allocate a hundred million objects in one
  synchronous loop — one request, portal gone. Map numbers are now bounded by
  the series length, scores to sane integers, map names truncated.
- **Steam start commands can no longer reach a root shell.** The generated
  start script interpolated the operator's command into a root-context
  string, so a `$(...)` in it ran as container root before the privilege
  drop — reachable even via a hostile Steam appinfo prefill. The command now
  travels in a single-quoted variable; substitutions execute only as the
  unprivileged game user, as the product always promised.
- **Match tokens stay out of logs.** The MatchZy config URL carried the
  per-match bearer token, and Fastify logs URLs; whoever reads logs could
  forge match results. The config is now fetched with the token in a header
  (never serialized), the header is on the redact list for good measure, and
  the organizer's override response no longer returns the token to a browser.
- **A failed match-server boot no longer deadlocks tournaments.** A boot that
  gave up used to sit in 'provisioning' forever — leaking the container, its
  port and its Steam token, and blocking every other match behind the
  one-boot-at-a-time gate, across restarts. It is now torn down and returned
  to the queue.
- Smaller hardenings: unexpected server errors answer a generic message
  instead of echoing internals; a dead rcon connection can no longer pass for
  a successful command; port-forward deletion is scoped to the server in the
  URL; the router TLS pin is enforced inside the handshake (before
  credentials flush) for UniFi and MikroTik; tournament updates enforce the
  same bounds as creation; deleted servers are evicted from every cache.

### Fixed

- **The 7d window shows seven days now.** Metrics retention was 24 hours, so
  the dashboard's 7d button silently showed the same single day as 24h.
  Retention is a week, long series are downsampled server-side (charts and
  phones get ~400 points, with counter rates and player peaks preserved), the
  per-server Metrics tab gained its own 7d range, and the restart counters
  are counted over the whole log in SQL instead of the last 500 rows — which
  could quietly undercount on a busy window.
- **CPU is of the machine now.** Metrics used docker-stats' one-core
  convention, so a server using just over one core showed "104% CPU" on a
  sixteen-core box. The percentage is now of the whole machine (0-100), with
  the per-core truth beside it as "1.04 of 16 cores" — the number that shows a
  single-threaded game being CPU-bound while the machine looks idle. History
  recorded before the change ages out within the 24-hour retention window.

## 1.2.0 — 2026-10-03

### Added

- **Tournaments (beta).** Single-elimination brackets played on CS2 servers
  the portal builds per match and retires after: teams with captains and
  Steam64 rosters, seeding, byes, per-round scheduling, in-game map veto via
  MatchZy, automatic results and bracket advancement, the organizer's
  override as the one correction path, Discord pings when a match server is
  ready and when results land, standings, and a shareable public page at
  /t/<slug> in the portal's own look (team names always; player names only
  when the organizer says so). Each match server gets its own port, password
  and Steam game server token, minted and retired automatically. The whole
  feature wears a **beta** tag until real tournament nights have worn the
  edges off; the provisioning chain itself has been validated end to end on
  real hardware.
- **Three more router vendors.** Settings → Router now also offers
  **Fritz!Box** (TR-064), **MikroTik** (RouterOS 7 REST, certificate pinned on
  first contact) and generic **UPnP** for most consumer routers, next to
  UniFi. Written to the vendors' published APIs and awaiting real-hardware
  confirmation — the connect test is a real call, so problems surface at
  connect time.
- **Forwarding verified without a router.** The Network tab asks the game
  itself through the public address — an answer proves container port, forward
  and router in one go, with no router integration needed. When nothing
  answers, it says plainly which ports to forward manually (with the
  NAT-hairpin caveat spelled out). With a router connected the probe is
  skipped: the rules listing is the authoritative answer there.
- **Start commands Steam never wrote down.** When an app's Steam info lists no
  Linux launch entry, the registry fills in the known start script for
  recognised games (7 Days to Die, Project Zomboid), and for everything else
  the command may stay empty: the server finds its own conventional start
  script (`startserver.sh` and friends) on first boot — and refuses loudly
  instead of guessing when none exists.

### Changed

- **Licence: AGPL-3.0-or-later** from this release. Still genuinely open
  source and free to self-host; anyone offering GameKeepr as a service to
  others must publish their modifications. Versions up to 1.1.0 were MIT and
  remain MIT.

## 1.1.0 — 2026-10-02

### Added

- **Joining, up front.** Deploying a recognised game now asks for the join
  settings — password, world, server name — in their own section at the top of
  the deploy form, instead of leaving them buried among template variables.
- **A Joining card on every server's overview**: address, port, server name,
  world and the password, visible to everyone who may see the server. A fresh
  server's password used to be visible to nobody at all.
- **Automatic port forwards.** With a router connected, a deploy opens the
  game's ports by itself and says so in the deploy log. Administrative ports
  (RCON, web consoles) are never opened automatically — those keep the
  deliberate click on the Network tab.
- **Rename from the card.** Operators rename a server where they see it; the
  container, id and URLs stay put. Servers from `config/servers.json` are
  declined with directions to the file.
- **Delete from the card.** Owners can delete a portal-deployed server: the
  container is stopped and removed, the portal forgets it — and the game's
  data and backups deliberately stay on disk.
- **A picture on every Steam server.** Steam artwork now falls back through
  the store's capsule and header images, and a Steam deploy records which app
  id its art belongs to (the game's, not the dedicated-server tool's). The
  lettered tile is now a bug, not a fallback.
- **Settings → Steam game server tokens**: paste a Steam Web API key once and
  the portal mints and retires game server login tokens (GSLTs) itself —
  groundwork for tournaments.

## 1.0.0 — 2026-10-01

First public release, and the version submitted to Unraid Community
Applications (listed in the catalog on 2026-10-02).

- Restarts verified against the game itself, with per-game startup times, a
  cooldown, and an activity feed.
- Three roles (owner, operator, member) with per-server exceptions; sessions,
  audit log, Discord notifications.
- Install game servers from Unraid Community Applications templates (reviewed
  before anything runs) or from ~580 dedicated servers on Steam, composed on
  Valve's official steamcmd image.
- Schedules that skip when players are online, world backups with safe
  restores, live logs with a console, typed per-game settings, file editor.
- Mod installs with hash verification, archive-safety checks and optional
  VirusTotal/ClamAV scanning; Steam Workshop declarations.
- Cloudflare Access guest list management, UniFi port forwarding, metrics,
  and a built-in wiki documenting all of it.
- Runs on any Docker host; hardened variant through docker-socket-proxy.

Release tags and diffs live on
[GitHub releases](https://github.com/KenGoossens/Gamekeep/releases).
