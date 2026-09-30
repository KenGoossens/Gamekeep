# Users, access and integrations

## Accounts

Users page → add a user with a role (see *Roles and permissions*). The new
account gets a one-time password to hand over on any channel you like — it
must be replaced at first sign-in and can do nothing until then. From the
same page: reset passwords, disable accounts, change roles, delete.

**Per-server exceptions** live behind each user's *Access…* button: make
someone operator of one server, member on one, or hide a server from them
entirely. The rule is the role; the row is the exception.

## Sessions

The Users page shows who is signed in right now, from which browser, and lets
you end sessions. Role changes and disables take effect on the next request —
no waiting for a session to expire.

## The outer door: Cloudflare Access

When the portal is published through Cloudflare Access, GameKeepr can manage
the guest list itself: Settings → Access shows the emails on the policy, and
adding a friend is one field instead of a trip to the Cloudflare dashboard.
Two doors stay deliberately separate — removing someone from Access keeps
them out entirely; removing their GameKeepr account keeps them signed out of
the portal.

## Notifications

Settings → Notifications takes a Discord webhook. What gets announced:
deliberate actions (restarts, starts, stops, deploys, mod installs — with who
did it), and the watcher's findings (a server that stopped **without anyone
asking**, and its recovery). Every embed carries the game's artwork and one
colour per kind of news.

## Malware scanners

Settings → Malware scanning, both optional: a **VirusTotal** key (lookups by
hash — the file itself never leaves the machine) and/or a **ClamAV** daemon
you run yourself. With neither configured, mod reports say "no scanner is
configured" — never "clean".

## The router

Settings → Router connects a UniFi controller with an API key, after which
the per-server Network tab can create port forwards instead of only listing
what is missing. The controller's TLS certificate is pinned on first contact.

All stored integration secrets are encrypted at rest with `SESSION_SECRET`.
