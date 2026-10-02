# Changelog

All notable changes to GameKeepr. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org). The `latest` image on ghcr.io moves
only when a version is released; `edge` tracks the main branch between
releases.

## Unreleased

- **Forwarding verified without a router.** The Network tab now asks the game
  itself through the public address — an answer proves container port, forward
  and router in one go, with no router integration needed. When nothing
  answers and no router is connected, it says plainly which ports to forward
  manually (with the NAT-hairpin caveat spelled out).
- **Licence change: AGPL-3.0-or-later.** From the next release the core is
  AGPL: still genuinely open source and free to self-host; anyone offering
  GameKeepr as a service to others must publish their modifications. Versions
  up to 1.1.0 were MIT and remain MIT.
- **Start commands Steam never wrote down.** When an app's Steam info lists no
  Linux launch entry, the registry now fills in the known start script for
  recognised games (7 Days to Die, Project Zomboid), and for everything else
  the command may stay empty: the server finds its own conventional start
  script (`startserver.sh` and friends) on first boot — and refuses loudly
  instead of guessing when none exists.
- **Tournaments** are in development: teams, brackets, and a CS2 match server
  provisioned per match with MatchZy reporting the results back. The feature
  will ship behind a **beta** label until it has been tested and validated
  end to end.

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
