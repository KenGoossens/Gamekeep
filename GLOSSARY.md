# GameKeepr

A self-hosted portal through which a server owner's friends see, restart and
manage the game servers on one machine, without access to the machine itself.

## Language

**Server**:
A game server the portal manages: one Docker container running one game.
_Avoid_: instance, box, machine (those mean the host)

**Owner / Operator / Member**:
The three portal roles, in descending privilege. Per-server exceptions can
raise or lower one user on one server.
_Avoid_: admin, moderator

**Deploy**:
Creating a new Server through the portal, from an Unraid template or a Steam
dedicated server.
_Avoid_: install (reserved for mods), provision

## Deploy assurance

**Preflight**:
The report produced before a Deploy creates anything: every refusal and
warning, with reasons, in one place. A failing Preflight blocks the Deploy;
warnings require acknowledgement. Both deploy paths (catalogue and Steam)
pass through one.
_Avoid_: what-if, dry run (nothing is simulated — it is checked), review
(taken by the template/image review it extends; the preflight module's
function names carry "review" as a historical exception)

**Deploy Verification**:
The phase after a Deploy starts the container: the first boot is followed
until the game proves it is up, and the outcome is reported honestly as
success, unconfirmed or failure. Slow is never failure; a reachable game
reporting a different server name than configured is unconfirmed, not
success.
_Avoid_: health check (that is the portal's own dependency page), smoke test

**Game Settings**:
The game's own configuration — server name, world, server password, admin
password and the like — wherever the game stores it: a config file inside the
Server, or environment variables, per what the registry knows about that game.
Distinct from Settings (the container's environment variables as a flat list).
_Avoid_: server config, properties

**Settings Scan**:
The search, after a verified Deploy, for where a Server keeps its Game
Settings, so the portal can offer to configure them. Which source is
authoritative (file or environment) comes from the registry, with runtime
detection as the fallback warning.
_Avoid_: discovery, probe

**Validation Run**:
An owner-initiated (or scheduled) run that deploys catalogue and Steam apps
for real, one at a time, verifies each against the Deploy Verification bar,
and tears everything down — volume included — reporting per app. Exists to
prove what the portal offers, not anyone's server.
_Avoid_: testbench, test bench, CI (it runs on the owner's machine, on real
images)

**Tournament**:
A competition among portal users, decided across one or more Matches according
to its format. The first format is a bracket; a points-series format (battle
royale style) is a later, second format.
_Avoid_: event, league, season (undecided concepts)

**Match**:
One scheduled contest between two Teams within a Tournament, played as a
best-of-1, -3 or -5 series of maps, with one result.
_Avoid_: game, round (a round is part of one map)

**Team**:
A named group of portal users that enters Tournaments as one side. Registered
and managed by its Captain; its size is dictated by the Tournament.
_Avoid_: squad, party

**Captain**:
The portal user who registers a Team, manages its roster and enters it into a
Tournament.
_Avoid_: leader, owner (taken)

**Organizer**:
The user who runs one Tournament: corrects the bracket, rules on no-shows and
results. Per-tournament; only Owners and Operators are eligible.
_Avoid_: host, admin

**Map Pool**:
The set of maps a Tournament allows. For a best-of series, the Teams veto the
pool down in-game; the portal records what was played.
_Avoid_: map list, rotation

**Match Server**:
A Server provisioned for a single tournament match and retired when the match
is decided. Distinct from a standing Server: it exists for the match, not for
the community.
_Avoid_: lobby, room

**Tournament Page**:
The public, read-only view of one tournament: bracket or standings, schedule,
results. Shareable by link; shows no controls.
_Avoid_: spectator view, overlay
