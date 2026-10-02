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

## Tournaments

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
