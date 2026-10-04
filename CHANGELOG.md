# Changelog

All notable changes to GameKeepr. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org). The `latest` image on ghcr.io moves
only when a version is released; `edge` tracks the main branch between
releases.

## Unreleased

### Added

- **The Settings Scan: the game's own config file, found and edited in
  place.** For games the registry knows well enough (Minecraft, Project
  Zomboid, 7 Days to Die to start), the Settings tab now locates the file the
  game actually loads — `server.properties`, `servertest.ini`,
  `serverconfig.xml` — inside the server and shows its join settings with
  labels. The file beats environment variables as a source of truth where the
  image allows it: its keys are defined by the game and identical under every
  image, while env spellings differ per maintainer (the Valheim lesson,
  attacked at the root). Saving stops the server, edits only the asked-for
  lines (same timestamped backup as a hand edit), restarts, and then runs the
  same first-boot verification a deploy gets — the game answering as the name
  you just set is the proof the change landed. Images known to regenerate the
  file from environment variables (Minecraft's itzg) are shown read-only with
  a pointer to the matching variables, instead of offering an edit that would
  be silently undone. A verified deploy now points at this section for the
  "now set your server name and password" moment.

- **Deploy verification: created is not the same claim as works.** Every
  deploy now gets a first-boot watch that follows the new server until the
  game itself answers — and where the game reports a server name, until it
  answers *as the name it was configured with*, which proves the settings
  actually landed (the failure the Joining-card bug taught us). Three honest
  endings: **verified** (the game answered as itself), **unconfirmed** (it
  runs but full proof never came — a silent game, a mismatched name, or no
  query protocol to ask), and **failed** (the container died; its exit code
  and a pointer to the Logs tab come along). First boots get first-boot
  patience: past the game's normal startup budget the watch keeps waiting as
  long as the download demonstrably progresses (network and disk counters
  moving), up to an hour — slow is never reported as broken. The outcome lands
  on the deploy screen live, in the activity feed, and on Discord (three new
  notification events). A failed first boot keeps the server by default — a
  35 GB download is not thrown away over a late answer — with "clean up"
  one deliberate click away.

- **Deploy preflight.** The values you type into a deploy form are now judged
  before anything exists, in the same pass/warn/fail report language the
  template and image reviews already speak. A join setting that breaks the
  game's own rules is refused in the form (a four-character Valheim password
  used to boot a server that then refused to start, minutes later and much
  more quietly); deploying without a server password proceeds only after an
  explicit acknowledgement that anyone who finds the address can join.
- **The Steam tab gained the review step it never had.** Whether an app allows
  anonymous SteamCMD downloads is judged up front from Valve's own
  dedicated-servers list (103 apps carry a definitive answer; three with
  contradictory wiki rows are deliberately left "unknown" rather than
  guessed): a known "no" warns you to set a Steam account before the first
  start fails on it, instead of an hour into the download in a log line. A
  wrong list entry never blocks a deploy — acknowledge and try. The missing
  Linux build refusal now speaks the same report language.
- **Admin passwords are a first-class join setting.** Games with a separate
  administrator credential (Palworld today, more as the registry grows) ask
  for it at deploy time; afterwards it is visible to operators on the Joining
  card and never to members, masked in Settings like every other credential.
- **Text settings can carry length rules.** The registry can now say "at least
  five characters" about a password, and both the deploy form and the Settings
  tab enforce it — Valheim's five-character minimum is the first.

- **Double elimination and round robin.** The tournament's format is picked at
  creation: single elimination (the classic), double elimination (a losers
  bracket catches every first loss; the two survivors meet in a single grand
  final — no bracket reset; needs at least three teams) or round robin
  (everyone plays everyone once, the standings crown the champion). Byes work
  in every format — in double elimination a bye never produces a
  losers-bracket opponent, and the bracket accounts for that on its own. The
  bracket, the schedule columns and the public page all speak the format's
  language (winners/losers rounds, grand final, round-robin rounds).
- **Check-in.** Each match card carries a Check in button for the two
  captains; a green ✓ next to the team tells everyone who is ready. It never
  blocks a match — it is the readiness signal, and the paper trail when a
  no-show becomes a forfeit.
- **Self-reported results with confirmation.** For games that cannot report
  their own scores, both captains get "team won" buttons; the result stands
  the moment the two reports agree. Disagreeing reports decide nothing — the
  card says "reports disagree" and the organizer settles it through Decide.
  CS2 matches refuse self-reports; the game already told the truth.
- **Tournament cloning.** Clone copies a tournament's settings — game, format,
  team size, series length, map pool — and its entered teams into a fresh
  draft with its own public address. Matches, results and seeds stay behind.

### Fixed

- **Valheim's password now shows on the Joining card.** ich777's Valheim image
  spells its variables `SRV_PWD`/`SRV_NAME`/`WORLD_NAME` where others use
  `SERVER_PASS`/`SERVER_NAME`; the Joining card only knew the second spelling
  and reported "no password set" on a server that very much had one. The
  connect settings now know both spellings (only variables the container
  actually has are shown), and `PWD`-style variables are masked in Settings
  like every other credential.

- **Match servers are servers now.** While a tournament match server lives it
  stands in Servers like any other card — match badge, its game's poster,
  player count, performance charts, live logs, console and Files through the
  existing tabs. What it never gets is a steering wheel: restart, stop,
  rename, delete and the standing-server tabs are refused, because its
  lifecycle belongs to the tournament, and the card disappears on its own at
  teardown (which the watcher knows is not an outage). Team management moved off the
  Tournaments list onto each tournament's own Teams tab, beside the bracket.
- **Tournaments for any game.** The game picker now offers
  games where team-vs-team is real (Minecraft, V Rising, Palworld, Terraria)
  next to Counter-Strike 2, plus a free "Other game…" field for any contest.
  CS2 keeps its automatic flavour (a
  server per match, results from the game); every other game plays wherever
  you play and the organizer records results through Decide — bracket,
  seeding, scheduling, standings and the public page are identical. Maps are
  optional for non-CS2 tournaments, and the card wears the chosen game's
  poster.

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
