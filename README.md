# Gamekeep

Let the people you play with look after your game servers, without giving them
access to your server.

They open a URL, sign in, see which servers are up and who is playing, and press
**Restart** when a game update lands. A cooldown stops anyone restarting a server
that is still booting, and a shared activity log shows who did what.

Built for the case where you are away from home, an update drops, and the server
needs a kick.

## What it does

**For everyone**

- **Restart** a server, with a cooldown and a live view of what it is doing
- **See what is running** — status, uptime, player counts and player names for a
  few hundred games, through GameDig

**For operators**

- **Start and stop** servers
- **Follow the logs live** — the container console, and the game's own log files
  where it keeps them
- **Install mods** from a repository or from a file you upload, each checked
  before anything is written
- **Edit settings and files**, with a backup on every change
- **Install new game servers** from the Unraid Community Applications catalogue,
  after a report on what the template asks for
- **Open the ports** a new server needs, if you connect a router

**For the owner**

- **A dashboard** of the whole fleet — who is playing, what is running, and
  whether any restart failed
- **Discord notifications** when a server is restarted, stopped, or falls over on
  its own
- **Manage who may reach the portal** through a Cloudflare Access policy
- **See who is signed in**, from where, and sign them out
- **Three roles**, so looking after servers can be delegated without handing over
  the accounts
- **An audit log** of every sign-in, action and refusal, with the address it came
  from

## Requirements

Any machine running Docker. It talks to the Docker socket and nothing else, so
Unraid, Synology, Proxmox, a Raspberry Pi or a plain Linux box all work. Unraid
gets two extras — see [On Unraid](#on-unraid).

## Install

```bash
git clone https://github.com/KenGoossens/Gamekeep.git
cd Gamekeep
cp .env.example .env
```

Fill in `.env` — every value is documented there. The two that must be set:

```bash
PUBLIC_URL=https://portal.example.com     # or http://192.168.1.10:8088
SESSION_SECRET=$(openssl rand -hex 32)
```

Then list the servers the portal may touch:

```bash
cp config/servers.example.json config/servers.json
```

```jsonc
{
  "servers": [
    {
      "id": "valheim",                  // used in URLs; never a container name
      "displayName": "Valheim",
      "container": "Valheim",           // exact name from `docker ps`
      "query": { "type": "valheim", "host": "Valheim", "port": 2456 },
      "steamAppId": 892970,             // optional: fetches the official artwork
      "cooldownSeconds": 300,
      "restartTimeoutSeconds": 300
    }
  ]
}
```

```bash
docker compose up -d --build
docker logs gamekeep        # prints the one-time SETUP TOKEN
```

Open the portal, paste the token, and create the owner account. Setup then closes
permanently.

A built image is published to `ghcr.io/kengoossens/gamekeep:latest` if you would
rather not build one.

### Getting servers.json right

| Field | Notes |
|---|---|
| `container` | Exactly as `docker ps --format '{{.Names}}'` prints it. Case matters. |
| `query` | Optional. Leave it out and the card simply shows no player count — and no mods, since the portal then cannot tell which game it is. |
| `query.type` | A [GameDig](https://github.com/gamedig/node-gamedig/blob/master/GAMES_LIST.md) id — `valheim`, `palworld`, `minecraft`, `minecraftbe`, `satisfactory`, … |
| `query.host` | The container's **name** if it shares a Docker network with the portal — that survives IP changes. Otherwise the host's LAN address. Never `localhost`: that is the portal container. |
| `query.port` | The game's **connect** port, not its query port. GameDig applies each game's offset itself: give Valheim `2456` and it queries 2457. |
| `restartTimeoutSeconds` | How long to wait for the game to answer before reporting failure. Big modded worlds need several minutes. |

Servers deployed through the portal get their `query` block written for them, by
recognising the game from the catalogue entry.

### Roles

| | restart | logs | stop / start | mods, files, settings | deploy | users, integrations |
|---|---|---|---|---|---|---|
| **owner** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **operator** | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| **member** | ✓ | — | — | — | — | — |

Logs are operator-level on purpose: they carry player addresses, join and leave
times, and whatever a server prints at start-up.

New accounts can only be made member or operator; an owner is made by promoting
someone afterwards, so a typo cannot hand over the keys. The last owner cannot be
demoted, disabled or deleted.

### Per-server exceptions

The global role is the rule; the owner can add an exception per server from
the Users page: make someone **operator of one server** ("sam runs the Valheim
box"), **member on one** ("ripper can restart it but not reconfigure it"), or
**hide one entirely**. Hidden means absent: the server is missing from their
lists, dashboard and activity feed, and its pages answer 404 — not 403,
because telling someone a hidden server exists is exactly what hiding is for.

Owners cannot be given exceptions. Whoever owns the machine owns every server
on it, and a row claiming otherwise would only be confusing to honour.

## Security model

The portal mounts `/var/run/docker.sock`, which is **root-equivalent on the
host**, and it is meant to be reachable from the internet. So the API is designed
as if it were hostile-facing:

- **Clients never name a container.** A request addresses a server by an `id` you
  chose in `config/servers.json`; the portal resolves that to a container name
  internally. Asking to restart `plex` or `../../something` returns 404.
- **No public sign-up.** The first account is created once, through a setup page
  gated by a token printed to the container log — so claiming it needs access to
  the server, not merely the URL.
- **Passwords are hashed with scrypt** and failed sign-ins are throttled per
  account and per source address. An unknown username and a wrong password return
  the same answer after the same work.
- **Temporary passwords can do nothing.** A new user must replace theirs before
  any other route will answer.
- **Revocation is immediate.** Disabling, demoting, deleting a user or changing a
  password drops their sessions on the spot.
- **`config/servers.json` is mounted read-only.** The portal never writes it.
- **File editing is confined** to a server's own mounted directories, text
  formats only, with a backup before every change.
- **Integration credentials are encrypted at rest** with a key derived from
  `SESSION_SECRET`, which is not in the database — so a stolen copy of the
  database alone reveals nothing.

The remaining risk is the socket itself, and an owner or operator password is
effectively a root password. Use a long unique one, and put something like
Cloudflare Access in front if you expose the portal. See
[Optional hardening](#optional-hardening) to narrow the socket.

## Mods

**Mods → operator level, and only while the server is stopped.**

Mods come from a repository the portal knows, or from a file you upload. Either
way you get a report before anything is written, and nothing in it says a mod is
safe — no check can decide whether third-party code running inside your game
server is hostile. What it reports is what was actually established:

| Check | What it means |
|---|---|
| **Integrity** | The download matches the hash the repository published. Thunderstore publishes none, and an uploaded file has none, and the report says so rather than implying a check happened. |
| **Archive safety** | Parsed and judged before a single byte is decompressed: path traversal, absolute and drive-letter paths, symlinks, device nodes, compression ratio, entry count, and a declared size that does not match what unpacks. These refuse outright. |
| **Malware scan** | Optional and off by default. With nothing configured the report says "no scanner is configured", never "clean". |
| **Compatibility** | The mod loader must be present, every required dependency installed, and its version range satisfied. |
| **Maintenance** | Whether the author marked it deprecated. There is no vulnerability database for game mods; this is the closest honest signal. |

Repositories, by game:

| Game | Repository | Notes |
|---|---|---|
| Satisfactory | [ficsit.app](https://ficsit.app) | Searchable. Client-only mods are left out, since a dedicated server cannot run them. |
| Minecraft (Java) | [Modrinth](https://modrinth.com) | Searchable. A `.jar` is installed as one file. |
| Valheim, V Rising, Lethal Company, Risk of Rain 2 | [Thunderstore](https://thunderstore.io) | No search endpoint exists, so a mod is named exactly — a package URL or `Author/ModName`. |

Anything else, and anything a repository does not carry, can be uploaded as a
`.zip`, `.jar` or `.smod` up to 192 MB. Games with mods but no usable API say so
in their own words rather than showing an empty tab.

Removing a mod deletes exactly the paths recorded when it was installed.

### Steam Workshop games

Project Zomboid and ARK work differently, and get a different screen. Their
servers collect their own mods: you give them a list of Workshop ids and they
download them through SteamCMD on the next start. So the portal writes a config
line rather than a file, and **nothing is downloaded or scanned here, because
nothing is downloaded here** — the portal never sees the mod's code.

Paste the address of the mod's Workshop page (Steam has no open search without
an API key, and needing one to add a mod is a worse trade than pasting a link).
What can be checked, is:

| Check | What it means |
|---|---|
| **Right game** | A Workshop item is published against one game, so an ARK mod on a Project Zomboid server is a fact, not a guess. Refused outright. |
| **Still there** | Items Steam has removed are refused, and ones already on the list that Steam no longer knows are flagged — the server retries that download on every start. |
| **Age and reach** | When it was last updated and how many people run it. Warnings, never verdicts. |

Project Zomboid keeps two lists — the Workshop ids it downloads and the mod
names it then loads — and a mod in only one of them does nothing. Gamekeep
maintains both, reading the mod's name out of its Workshop description the way
every Project Zomboid mod manager does. If a publisher did not put one there,
it says so instead of guessing.

Changes need a restart to take effect, and the config is only editable while the
server is stopped — the same rule as the Files and Settings tabs.

### Malware scanning

**Settings → Malware scanning**, as owner. Both are optional:

- **VirusTotal** is looked up by hash, so the file is never uploaded anywhere. A
  free account is enough.
- **ClamAV** is streamed to a `clamd` you run yourself; nothing leaves your
  network.

Neither can tell you a mod is safe. What they give is the multi-engine opinion on
those exact bytes, which you would otherwise have to go and get by hand.

## Logs

**Logs → operator level, and available while the server runs.**

Two sources. The **container console** is whatever the server writes to stdout,
streamed live over Server-Sent Events. The **game's own log files** are found
automatically where a game keeps them — `FactoryGame.log`, `enshrouded_server.log`,
`logs/latest.log` and so on — and read from a byte offset rather than followed
with `tail -f`, so nothing is left running inside the game server after you close
the tab.

The view follows the newest line until you scroll up, then stops and says so. It
keeps three thousand lines; a chatty server produces far more in an evening.

## Console

The Logs tab is also a console. Under the live stream sits an input that
writes one line to the game's own stdin — `save-all`, `say Restart in 5
minutes`, `kick <name>` — and the answer comes back through the same log
stream. One line per send, operator level, and every command lands in the
audit log verbatim.

Two container properties gate it, and the portal says so instead of failing
vaguely: the container must have an interactive stdin (Unraid's "Interactive"
toggle, `docker run -i`), and it must not be set to close stdin after one
attach (`StdinOnce`) — a game that reads end-of-input as "shut down" would
otherwise be stopped by the very act of talking to it.

## Notifications

**Settings → Notifications**, as owner. A Discord webhook — one URL, no bot.

Reported by default: a server restarted, started or stopped, a restart that came
back unconfirmed, a restart that failed, and a server that went down or came back
on its own. Deployments, mod installs and access changes can be added.

A server that stopped because someone asked it to is told apart from one that
fell over; only the second is reported as a fault. Repeats of what the portal
merely *noticed* are collapsed for ten minutes, so a crash loop does not produce
a message every thirty seconds — but every deliberate action is always reported,
including a second restart a minute after the first.

## Who can reach the portal

**Settings → Who can reach the portal**, as owner, if you put Cloudflare Access
in front of it.

Connect a Cloudflare API token scoped to **Access: Apps and Policies — Edit** and
nothing more, name the policy the portal may edit, and email addresses can be
added and removed from it here. A broader token would let the portal edit DNS and
remove the gate protecting itself.

The policy is read, changed in one specific way, and written back whole:
requirements, exclusions, the decision and any rule that is not a plain email
address are carried across untouched. Removing the last rule is refused — a policy
matching nobody locks everyone out, including whoever pressed the button.

Adding an address is operator-level, because it only lets someone reach the
sign-in page; connecting Cloudflare stays with the owner, because it stores a
credential.

## Installing new servers

**Add server → operator level.** The catalogue is Unraid's Community
Applications, filtered to a trust list of publishers.

Before anything is pulled you get a report on what the template asks for —
privileged mode, host devices, host paths, host networking, administrative ports,
credentials already filled in — and on what the registry says the image is: which
digest the tag resolves to today, when it was last built, and whether it runs as
root. That last pair is the closest honest answer to "is this vulnerable": there
is no CVE feed for game-server images, but one nobody has rebuilt in two years is
carrying whatever its base layer shipped with.

The image is looked up rather than pulled, so a few kilobytes of manifest answer
those questions without committing the disk and bandwidth of a multi-gigabyte
image first.

Templates asking to run privileged, or for host devices, are refused outright.
Host paths from a template are ignored and replaced with ones the portal
controls, and `ExtraParams` is never applied. The resolved digest is recorded in
the audit log, because a tag can be moved afterwards.

### Any dedicated server on Steam

The catalogue has a second tab: **Steam**. Where the Unraid tab trusts a
template author, this one trusts exactly two parties — Valve's official
`steamcmd/steamcmd` image and Steam's own depots — and Gamekeep composes
everything in between itself.

How it works: Steam's own app info carries each app's launch configuration
(the same data `app_info_print` shows), which is the missing half of a
generic deploy — SteamCMD can download any app id, but only the app info says
how to start it. Gamekeep reads it, proposes the most headless-looking Linux
launch line (xterm wrappers are swapped for the plain script they wrap), and
shows it for the operator to confirm or correct. The generated start script
downloads the app through SteamCMD on every start (which is also how the
server updates), drops root for a `99:100` user, links `steamclient.so`
where games expect it, and becomes the game. Script and a matching
`docker-compose.yml` land inside the server's own volume, readable in the
Files tab — the compose file reproduces the server anywhere, portal or not.

Finding a server, three ways:

- **Paste an app id or store/SteamDB URL** — always works, needs nothing.
- **Search without a key** — covers servers that have a store page.
- **Search with a free Steam Web API key** (steamcommunity.com/dev/apikey,
  owner sets it once) — covers every "dedicated server" Steam lists,
  refreshed weekly.

Games the registry recognises get their required ports prefilled and their
backups, mods, player counts and typed settings out of the box. Windows-only
servers are refused with the reason; apps that refuse anonymous downloads say
so in their first log lines, and a Steam account can be set on the container.
Composed servers keep stdin open, so the Console tab can type at them.

### Which network a deployed server joins

Its own — `GAME_NETWORK`, created and joined by the portal on the first deploy,
so there is nothing to set up.

Not the template's choice, which is almost always Docker's default bridge.
Containers there cannot resolve each other by name, so the portal would have to
reach a game server through the host's own address and back in, which works
until the address changes or `LAN_ADDRESS` is wrong. On a shared network the
player count uses the container name and keeps working.

Separate from the portal's own network by default, because Docker isolates
bridge networks from one another. A game server runs whatever mod code you
install on it, and there is no reason for it to be able to reach a tunnel or a
reverse proxy sitting beside the portal. Set `GAME_NETWORK` to the portal's own
network if you would rather keep everything together.

Published ports work the same either way, so this changes nothing about how
players connect.

## Reaching the game servers

The portal is a web app and goes behind a reverse proxy or a tunnel like any
other. **The game servers do not.** Players connect straight to the game over its
own protocol, so each game port still needs forwarding on your router — a reverse
proxy cannot help with that, and neither can a tunnel.

The **Network** tab on each server shows exactly which rules are needed. Without
a router connected it gives you a copyable list to enter by hand. Connect one and
it can create them for you.

Ports that look administrative — a web console, RCON — are flagged and never
pre-selected. Forwarding a game port lets people play; forwarding a web console
puts an admin interface on the internet.

### Ports the container never opened

Forwarding can only act on ports a container publishes, which means it is blind
to the one failure that matters most: a template that declared too few. Project
Zomboid needs UDP 16261 **and** 16262, its Unraid template declares only 16261,
and a server deployed from it came up green with multiplayer quietly broken.

So `server/src/games.ts` records what each game actually needs, looked up
against the game's own documentation rather than recalled. Two things use it:

- **Deploying** fills in required ports a template left out, and says so in the
  deploy log rather than adding them silently. A mapping you set yourself is
  never overridden.
- **The Network tab** compares an existing container against the registry and
  says outright when a port is absent — which no forwarding rule can fix.

A game with no ports listed at all is a statement too: Core Keeper, Lethal
Company and Risk of Rain 2 reach players through Steam, and genuinely need
none. A game that is not in the registry says it cannot tell, which is not the
same as saying everything is fine.

This deliberately is not looked up at runtime by a model. A port number is a
stable fact with a source, and a hallucinated one breaks multiplayer silently —
the server starts, the status is green, and only your friends find out.

### Connecting a router

**Settings → Router**, as owner. UniFi is supported today; the integration is a
small interface, so other routers are a single file to add. Credentials are
encrypted with a key derived from `SESSION_SECRET`, and the controller's
certificate is pinned on first connect.

## What counts as a successful restart

A running container is not a running game — a crashed server can sit inside a
perfectly healthy container indefinitely. So a restart is verified in two stages:
the container comes back, then the game answers a query. That produces three
outcomes, all visible in the activity feed:

| Outcome | What happened | Starts a cooldown? |
|---|---|---|
| **success** | Container came back and the game answered | Yes |
| **unconfirmed** | Container came back, the game never answered in time | Yes |
| **failure** | The restart did not happen — container missing, Docker unreachable | No |

`unconfirmed` starting a cooldown is deliberate: that server is most likely still
loading a big world, and letting people restart it again is the worst possible
response. A true failure stays retryable.

How long a game gets is per game, from the registry in `server/src/games.ts` —
Factorio answers in two minutes and an ARK server reinstalling its Workshop mod
list can take twenty. It is a deadline, not a wait: the verifier polls every two
seconds and finishes the moment the game replies. One number for every game
meant slow games reported healthy restarts as failures. Set
`restartTimeoutSeconds` on a server only to override the registry for that one.

## Schedules

**Schedule → operator level.** A standing instruction per server: restart, stop
or start at a set time on set days. The classic use is a nightly restart at
05:00, when the memory leak has had its day.

Deliberately not cron — a time and week days are the entire vocabulary the job
needs. Three rules keep a schedule from doing damage on its own:

- **It never turns a stopped server back on.** Someone stopped that server on
  purpose; a restart schedule skips until someone starts it again. Starting is
  its own schedule action for whoever really wants it.
- **"Skip when players are online"** (the default) asks the game itself at the
  moment of truth, not a cached count.
- **A missed run stays missed.** If the portal was down at 05:00, the restart
  does not fire at whatever time the portal comes back — it waits for the next
  05:00.

Runs go through the same machinery as a button press: two-stage verification,
cooldown, audit log and Discord all apply, with the schedule named as the
actor. Times run on the portal's own clock, and the tab says which time zone
that is — a container without `TZ` set runs in UTC, which you want to know
before 05:00, not after. Set `TZ` (e.g. `Europe/Brussels`) on the Gamekeep
container to change it.

## Backups

**Backups → operator level.** A backup holds the world and the server's own
config — the part no reinstall can bring back — not the tens of gigabytes
SteamCMD can fetch again. The game registry knows where each game keeps its
saves and searches the container for them; the operator confirms once, and
that choice is what every backup contains from then on.

- **Making one** works while the server runs: games flush their saves
  continually, and a mostly-consistent copy beats none.
- **Restoring** only happens while the server is stopped, and never without a
  safety copy of what is about to be replaced — a restore that turns out to be
  the wrong call must itself be undoable. Restores overlay: files created
  since the backup are left alone.
- **Rotation** keeps the newest ten per server; safety copies do not count.
- Backups land in the portal's own data volume (`BACKUP_DIR`, default
  `/data/backups`), so they survive the game container being recreated and
  ride along with whatever backs up appdata itself. Each can also be
  downloaded as a `.tar.gz` for a copy somewhere else entirely.

For a nightly backup, add a **backup** action on the Schedule tab. It runs even
when players are online — a backup kicks nobody.

## Restart or update?

`updateStrategy: "restart"` (the default) stops and starts the container. For most
game-server images — anything running SteamCMD on startup — that **is** the
update, because the entrypoint checks for a new build every boot.

`updateStrategy: "pull-recreate"` pulls the latest image and recreates the
container from its own configuration. Use it when the game ships inside the image.
It preserves environment, ports, labels, restart policy, volumes, networks and
aliases, and pulls *before* stopping anything — but it is the only destructive
path here, so try it on a scratch container first.

## Settings and files

### Typed settings

The game registry gives the variables it recognises a label, a line of
context and a type — the part of Pterodactyl's egg format worth having. Those
render as real controls (a toggle, a number field with its range, a dropdown)
and are validated server-side before anything is recreated: a player limit of
5000 is refused with the range, not passed to a game that will fail on it
minutes later with the server already down. Booleans keep whichever spelling
the image already uses (`true/false`, `1/0`, `yes/no`, `on/off`).

Every other variable still shows as the plain field it always was — a spec is
a courtesy, never a gate. Adding one is a few lines on the game's entry in
`server/src/games.ts`.


Both are locked while a server runs. Most game servers hold their configuration in
memory and write it back on shutdown, quietly undoing an edit — so the portal asks
you to stop first rather than let you lose work.

The editor opens text formats from the container's own mounted directories, keeps
a timestamped backup of anything it changes, and writes nothing at all if you
saved without changing something. Uploads accept any file type; creating new files
is text only.

## On Unraid

Two things work only here, and both are optional.

**Container templates.** Mount `/boot/config/plugins/dockerMan/templates-user` and
servers the portal deploys show up properly in your Docker tab instead of as
orphan images.

**Use a pool path, not `/mnt/user`.** The database is SQLite, and Unraid's
`/mnt/user` is a FUSE layer with long-standing SQLite locking problems — the same
reason Plex and the *arr apps tell you to keep their databases off it. Point the
data volume at `/mnt/cache/...` and make sure the share stays on that pool.

A Community Applications template is in
[`unraid/gamekeep.xml`](unraid/gamekeep.xml), pointing at the published image.

## Troubleshooting

**"Container not found"** — `container` does not match a real name. Check
`docker ps --format '{{.Names}}'`; case matters.

**Status works but the player count shows —** — the container is up but the game
is not answering. Usually it is still loading. If it persists, check `query.host`
and `query.port`, and remember GameDig wants the connect port.

**"Docker unreachable"** — the socket is not mounted, or `DOCKER_HOST` is wrong.

**A user cannot sign in** — check the Users page: the account may be disabled, or
still on a temporary password that has since been reset. Eight failed attempts
locks that account and address for fifteen minutes; restarting the container
clears it.

**A healthy server keeps reporting `unconfirmed`** — raise
`restartTimeoutSeconds` for it.

**The Mods tab says the game is unsupported** — it has no `query.type`, so the
portal cannot tell which game it is. Add one to `config/servers.json`.

**A mod will not install: "client-only"** — many mods build only for the game
client. There is nothing for a dedicated server to run, and the repository says so
before you download it.

**Changed `.env` and nothing happened** — environment variables are read when a
container is *created*. `docker restart` keeps the old ones; recreate it.

**Changed `SESSION_SECRET`** — everyone is signed out and every stored
integration credential becomes unreadable, since the key is derived from it.
Re-enter them in Settings.

## Optional hardening

Put [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
between the portal and Docker so it cannot reach the endpoints that would let it
create a privileged container. The stanza is in `docker-compose.yml`, commented
out. Enable `CONTAINERS`, `POST`, `IMAGES` and `EXEC`; leave `VOLUMES`, `NETWORKS`
and `SECRETS` off.

Note that deploying new servers and the stopped-container file browser both need
container creation, so narrowing the socket that far turns those off.

## Development

Node 22.5+ — the app uses Node's built-in SQLite, so there is nothing to compile.
The published image is built on Node 24.

```bash
cd server && npm install && npm run dev    # API on :8080
cd web    && npm install && npm run dev    # UI on :5173, proxying to the API
```

`server`'s dev script reads `../.env`. Relative paths there resolve against
`server/`, so use `../data` and `../config`. On Windows with Docker Desktop set
`DOCKER_SOCKET_PATH=//./pipe/docker_engine`.

A throwaway target to play with:

```bash
docker run -d --name testsrv nginx:alpine
# then { "id": "test", "container": "testsrv" } in servers.json, no query block
```

`server/scripts/fake-game-server.mjs` answers A2S queries, so you can exercise
player counts and the "game is responding" check without a real game server.

```bash
cd server && npm run typecheck
cd web    && npm run typecheck
```

### Adding a game

`server/src/games.ts` is the one place a game is described: its GameDig id, the
patterns that recognise it in a catalogue, its Steam app id, how long it may take
to start, where its mods go, and which repository serves them. Adding a game is
one entry there.

### Adding a mod repository

`server/src/mods/sources.ts` defines the interface; `ficsit.ts`, `modrinth.ts`
and `thunderstore.ts` are the implementations. A new one is a single file plus an
entry in `games.ts`.

For a game whose server fetches its own mods, give the profile a `workshop`
block instead of a `mods` one: which directory holds its config, which file and
INI section the list lives in, and which key. `server/src/mods/declare.ts` does
the rest — it searches the container for that file rather than assuming a path,
and rewrites one line while leaving every comment and unrelated setting alone.

## Licence

MIT
