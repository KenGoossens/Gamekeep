# Installing game servers

**Add server** offers two routes. They differ in who you are trusting.

## Unraid apps

Templates from Community Applications, limited to trusted publishers. Before
anything is created, GameKeepr reviews the template and shows its findings:
who published it, whether the image is what it claims, which paths it mounts.
Templates that ask for privileged mode are refused outright — no game server
needs root on the host.

## Steam

Any dedicated server Steam carries (~580 at the last count, recognised games
sorted first), as a container **GameKeepr composes itself** on Valve's
official `steamcmd` image. Here you trust exactly two parties — Valve's image
and Steam's own depots — and the one thing in between is a start script
GameKeepr writes, which lands in the server's own files where you can read it.

- The **start command** comes from Steam's own app info and is shown for you
  to confirm. When a server misbehaves on first start, the game's wiki
  usually documents the right headless command — edit it in the form or later
  in the Files tab.
- SteamCMD downloads the server on first start and re-checks on every start,
  which is also how it updates.
- Windows-only servers are refused with the reason. The rare app that refuses
  anonymous downloads says so in its first log lines; give the container a
  Steam account in the deploy form's login section.
- Anything not in the list: paste its app id or store/SteamDB URL in the
  search box.

## What both routes share

- **Ports**: GameKeepr's game registry knows what each recognised game needs
  and fills in anything the template or your list forgot — a Project Zomboid
  with only one of its two UDP ports looks healthy and is unjoinable, which is
  exactly the failure this prevents. The deploy log says what was added.
- **Network**: every deployed server joins GameKeepr's own Docker network, so
  the portal can reach it by name for player counts.
- **Registration**: the new server appears in the portal immediately, with
  player queries, mods, backups and typed settings wherever the registry
  recognises the game.

## Removing

Removing a portal-deployed server takes it off the list (with its schedules
and access exceptions); the container itself is left alone, so nothing is
destroyed by an accidental click.
