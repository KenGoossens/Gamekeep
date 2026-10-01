# Schedules

![Two schedules on a server, with the next run and the day picker](/api/wiki/images/schedule.png)

A schedule is a standing instruction per server: restart, stop, start or back
up at a set time on set days. The classic one is a nightly restart at 05:00,
when the memory leak has had its day and nobody is on.

It is deliberately not cron — a time and weekdays are the whole vocabulary
the job needs. No days selected means every day.

## The three protective rules

1. **A schedule never turns a stopped server back on.** Someone stopped that
   server on purpose; a restart schedule skips and says so. Wanting a server
   up at a fixed time is what the separate *start* action is for.
2. **"Skip when players are online"** (default for restart and stop) asks the
   game itself at the moment of truth, not a cached count. Backups ignore it
   — a backup kicks nobody.
3. **A missed run stays missed.** If the portal was down at 05:00, the
   restart waits for the next 05:00 instead of firing whenever the portal
   comes back.

## What a run looks like

Runs go through the same machinery as a button press: two-stage verification,
cooldown, the activity feed and Discord all apply, with the schedule named as
the actor. Each schedule's row shows its next run and what the last one did
("Done", "Skipped: 3 players are online", or the failure).

## Whose clock

Times run on the portal's clock, and the tab says which time zone that is and
what it currently reads. If it says UTC, the owner should set `TZ` (for
example `Europe/Brussels`) on the GameKeepr container — before 05:00, not
after.
