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
patterns that recognise it in a catalogue, where its mods go, and which
repository serves them. Adding a game is one entry there.

### Adding a mod repository

`server/src/mods/sources.ts` defines the interface; `ficsit.ts`, `modrinth.ts`
and `thunderstore.ts` are the implementations. A new one is a single file plus an
entry in `games.ts`.

## Licence

MIT
