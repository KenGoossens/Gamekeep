# The security model

![The activity feed: every action recorded, rejections included](/api/wiki/images/activity.png)

Written down so decisions are deliberate, not accidental.

## The centre of gravity

GameKeepr holds the Docker socket, which is **root-equivalent on the host**.
Everything else follows from taking that seriously:

- Clients never name containers. Every request addresses a server id, and the
  only ids that exist are the ones in `servers.json` plus what the portal
  itself deployed. There is no code path from user input to an arbitrary
  container.
- The portal never deploys privileged containers and never adds capabilities
  — refused in code, not in review.
- Operator accounts can change what runs on the machine. Treat handing out
  the operator role as handing out the machine.

## Doors and identities

Two independent layers: Cloudflare Access (email codes, keeps the internet
out) and GameKeepr's own accounts (scrypt-hashed passwords, per-browser
sessions, roles). Rate-limited logins, one-time passwords for new accounts,
sessions visible and revocable by the owner.

## What third-party code gets to do

- **Mods** are downloaded only from known repositories or uploaded by an
  operator; archives are parsed and judged before a byte is unpacked (path
  traversal, symlinks, device nodes, compression bombs), hashes verified
  where the repository publishes them, optional scanners consulted. No report
  ever says "safe" — that claim is not available.
- **Steam-composed servers** trust Valve's official image and Steam's depots;
  the start script in between is generated, visible in the Files tab, and
  runs the game as an unprivileged user (`99:100`), never root.
- **Templates** are reviewed before deploy. Privileged mode, host devices and
  dangerous host paths are refused for everyone; a publisher outside the
  trusted list is a warning the operator must acknowledge, never a silent
  pass. Validation runs skip unlisted publishers entirely — they start
  containers unattended, which is no place to execute an unknown image.

## Honesty rules

Things someone may not see answer **404, not 403** — a hidden server, a wiki
page above your role. Telling someone a thing exists is itself a disclosure.
Audit rows record rejections as well as successes; the rejections are the
interesting ones. Secrets are encrypted at rest, masked in every UI, and
never echoed back.

## Narrowing the socket

The optional `dockerproxy` service in the compose file puts a filter between
GameKeepr and the Docker socket, passing only the API groups it uses
(containers, images, networks, exec, POST) and refusing the rest — volumes,
secrets, swarm, system and plugins all answer 403. The preset is tested
against every feature, deploys included.

Be honest about what it buys: GameKeepr legitimately needs container creation
and exec, and the proxy cannot inspect request bodies, so it is
defence-in-depth, not a sandbox. The unforgeable rule remains the one in
GameKeepr's own code: no privileged containers, no client-named containers.

Unraid's built-in API (7.2+) offers scoped API keys, but its schema can
control containers, not create them — nor exec, attach or read files — so it
cannot carry GameKeepr's feature set today. Worth revisiting as it matures.

## What to rotate when

`SESSION_SECRET` invalidates all sessions *and* stored integration secrets —
rotate it only deliberately. Integration keys (VirusTotal, UniFi, the Discord
webhook, tunnel tokens) rotate at their own services; GameKeepr stores only
encrypted copies and survives any of them changing.

## What leaves this machine

Exactly two things can ever leave a GameKeepr install towards the project,
both documented on their own pages and both entirely in the user's hands:
the **opt-in, off-by-default** [anonymous usage statistics](/wiki/statistics)
(one hourly ping whose literal payload is shown before you decide; it feeds a
public statistics page everyone can read) and
[issue reports](/wiki/reporting-issues) (a prefilled GitHub form you read and
approve before submitting). Errors and logs are deliberately never collected —
they carry player names, addresses and paths.
