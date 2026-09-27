# Gamekeep

Let the people you play with restart your game servers, without giving them
access to your server.

They open a URL, sign in, see which servers are up and how many people are
playing, and press **Restart** when a game update lands. A cooldown stops
anyone restarting a server that is still booting, and a shared activity log
shows who did what.

Built for the case where you are away from home, an update drops, and the
server needs a kick.

## What it does

- **Restart, start and stop** containers — restart for everyone, start and stop
  for operators
- **Live status and player counts** for a few hundred games, through GameDig
- **Performance graphs** — CPU, memory and network, with 24 hours of history
- **Install new game servers** from the Unraid Community Applications catalogue
- **Edit settings and files** — environment variables and config files, with a
  backup on every change
- **Open the ports** a new server needs, if you connect a router
- **Three roles** so managing servers can be delegated without handing over the
  accounts
- **An audit log** of every sign-in, action and refusal, with the address it
  came from

## Requirements

Any machine running Docker. It talks to the Docker socket and nothing else, so
Unraid, Synology, Proxmox, a Raspberry Pi or a plain Linux box all work. Unraid
gets two extras — see [On Unraid](#on-unraid).

## Security model

The portal mounts `/var/run/docker.sock`, which is **root-equivalent on the
host**, and it is meant to be reachable from the internet. So the API is
designed as if it were hostile-facing:

- **Clients never name a container.** A request addresses a server by an `id`
  you chose in `config/servers.json`; the portal resolves that to a container
  name internally. Asking to restart `plex` or `../../something` returns 404.
- **No public sign-up.** The first account is created once, through a setup page
  gated by a token printed to the container log — so claiming it needs access to
  the server, not merely the URL.
- **Passwords are hashed with scrypt** and failed sign-ins are throttled per
  account and per source address. An unknown username and a wrong password
  return the same answer after the same work.
- **Temporary passwords can do nothing.** A new user must replace theirs before
  any other route will answer.
- **Revocation is immediate.** Disabling, demoting, deleting a user or changing
  a password drops their sessions on the spot.
- **`config/servers.json` is mounted read-only.** The portal never writes it.
- **Deploying is limited** to a trust list of publishers, and templates that
  ask for `privileged`, host networking or device access are refused. Host paths
  from a template are ignored and replaced with ones the portal controls.
- **File editing is confined** to a server's own mounted directories, text
  formats only, with a backup before every change.

The remaining risk is the socket itself, and an owner or operator password is
effectively a root password. Use a long unique one, and put something like
Cloudflare Access in front if you expose the portal. See
[Optional hardening](#optional-hardening) to narrow the socket.

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

Open the portal, paste the token, and create the owner account. Setup then
closes permanently.

### Getting servers.json right

| Field | Notes |
|---|---|
| `container` | Exactly as `docker ps --format '{{.Names}}'` prints it. Case matters. |
| `query` | Optional. Leave it out and the card simply shows no player count. |
| `query.type` | A [GameDig](https://github.com/gamedig/node-gamedig/blob/master/GAMES_LIST.md) id — `valheim`, `palworld`, `minecraft`, `mbe`, `satisfactory`, … |
| `query.host` | The container's **name** if it shares a Docker network with the portal — that survives IP changes. Otherwise the host's LAN address. Never `localhost`: that is the portal container. |
| `query.port` | The game's **connect** port, not its query port. GameDig applies each game's offset itself: give Valheim `2456` and it queries 2457. |
| `restartTimeoutSeconds` | How long to wait for the game to answer before reporting failure. Big modded worlds need several minutes. |

### Roles

| | restart | stop / start | install | manage users |
|---|---|---|---|---|
| **owner** | ✓ | ✓ | ✓ | ✓ |
| **operator** | ✓ | ✓ | ✓ | — |
| **member** | ✓ | — | — | — |

New accounts can only be made member or operator; an owner is made by promoting
someone afterwards, so a typo cannot hand over the keys. The last owner cannot
be demoted, disabled or deleted.

## On Unraid

Two things work only here, and both are optional.

**Container templates.** Mount `/boot/config/plugins/dockerMan/templates-user`
and servers the portal deploys show up properly in your Docker tab instead of
as orphan images.

**Use a pool path, not `/mnt/user`.** The database is SQLite, and Unraid's
`/mnt/user` is a FUSE layer with long-standing SQLite locking problems — the
same reason Plex and the *arr apps tell you to keep their databases off it.
Point the data volume at `/mnt/cache/...` and make sure the share stays on that
pool.

A ready-made Community Applications template is in
[`unraid/gamekeep.xml`](unraid/gamekeep.xml). Replace the `REPLACE_ME`
placeholders with your own repository, publish a built image, and it can be
installed in one click.

## Reaching the servers

The portal is a web app and goes behind a reverse proxy or a tunnel like any
other. **The game servers do not.** Players connect straight to the game over
its own protocol, so each game port still needs forwarding on your router — a
reverse proxy cannot help with that, and neither can a tunnel.

The **Network** tab on each server shows exactly which rules are needed. Without
a router connected it gives you a copyable list to enter by hand. Connect one
and it can create them for you.

Ports that look administrative — a web console, RCON — are flagged and never
pre-selected. Forwarding a game port lets people play; forwarding a web console
puts an admin interface on the internet.

### Connecting a router

**Settings → Router**, as owner. UniFi is supported today; the integration is a
small interface, so other routers are a single file to add. Credentials are
encrypted with a key derived from `SESSION_SECRET`, so a stolen copy of the
database alone reveals nothing, and the controller's certificate is pinned on
first connect.

## What counts as a successful restart

A running container is not a running game — a crashed server can sit inside a
perfectly healthy container indefinitely. So a restart is verified in two
stages: the container comes back, then the game answers a query. That produces
three outcomes, all visible in the activity feed:

| Outcome | What happened | Starts a cooldown? |
|---|---|---|
| **success** | Container came back and the game answered | Yes |
| **unconfirmed** | Container came back, the game never answered in time | Yes |
| **failure** | The restart did not happen — container missing, Docker unreachable | No |

`unconfirmed` starting a cooldown is deliberate: that server is most likely
still loading a big world, and letting people restart it again is the worst
possible response. A true failure stays retryable.

## Restart or update?

`updateStrategy: "restart"` (the default) stops and starts the container. For
most game-server images — anything running SteamCMD on startup — that **is** the
update, because the entrypoint checks for a new build every boot.

`updateStrategy: "pull-recreate"` pulls the latest image and recreates the
container from its own configuration. Use it when the game ships inside the
image. It preserves environment, ports, labels, restart policy, volumes,
networks and aliases, and pulls *before* stopping anything — but it is the only
destructive path here, so try it on a scratch container first.

## Settings and files

Both are locked while a server runs. Most game servers hold their configuration
in memory and write it back on shutdown, quietly undoing an edit — so the portal
asks you to stop first rather than let you lose work.

The editor opens text formats from the container's own mounted directories,
keeps a timestamped backup of anything it changes, and writes nothing at all if
you saved without changing something. Uploads accept any file type; creating
new files is text only.

## Troubleshooting

**"Container not found"** — `container` does not match a real name. Check
`docker ps --format '{{.Names}}'`; case matters.

**Status works but the player count shows —** — the container is up but the game
is not answering. Usually it is still loading. If it persists, check
`query.host` and `query.port`, and remember GameDig wants the connect port.

**"Docker unreachable"** — the socket is not mounted, or `DOCKER_HOST` is wrong.

**A user cannot sign in** — check the Users page: the account may be disabled,
or still on a temporary password that has since been reset. Eight failed
attempts locks that account and address for fifteen minutes; restarting the
container clears it.

**A healthy server keeps reporting `unconfirmed`** — raise
`restartTimeoutSeconds` for it.

**Changed `.env` and nothing happened** — environment variables are read when a
container is *created*. `docker restart` keeps the old ones; recreate it.

## Optional hardening

Put [`tecnativa/docker-socket-proxy`](https://github.com/Tecnativa/docker-socket-proxy)
between the portal and Docker so it cannot reach the endpoints that would let it
create a privileged container. The stanza is in `docker-compose.yml`, commented
out. Enable `CONTAINERS`, `POST`, `IMAGES` and `EXEC`; leave `VOLUMES`,
`NETWORKS` and `SECRETS` off.

## Development

Node 22.5+ — the app uses Node's built-in SQLite, so there is nothing to compile.

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

## Licence

MIT
