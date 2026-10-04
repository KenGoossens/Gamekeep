# Validation runs tear everything down, downloads included

A Validation Run exists to prove that the registry's data still produces a
working server from nothing: deploy a game for real, wait until it answers as
itself, then remove it. The tempting optimisation is to keep a shared SteamCMD
download cache between runs, because a full run re-downloads hundreds of
gigabytes. We deliberately do not: **every validation deploys onto a clean
slate and the teardown removes the container, its volume and its downloads.**

The reason is what the run is for. The experience being validated is a user's
*first* installation — the one that earns or loses GameKeepr its reputation —
and a warm cache is precisely the part of that experience a cache would skip.
A run that passes because last month's download was still on disk has proven
nothing about the path a new user walks. Bandwidth is the honest price of the
honest test.

## Consequences

- A full 19-game run costs hundreds of gigabytes and runs for hours; that is
  accepted, and the UI's default working mode after the first full run is a
  subset selection, not a nightly full sweep.
- Validation Runs are strictly sequential (one game at a time) so a run never
  competes with itself for disk, bandwidth or ports.
- If bandwidth ever becomes untenable, the escape hatch is running validations
  less often or on fewer games — never caching, which would change what is
  being tested.
