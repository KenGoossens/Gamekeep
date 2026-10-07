# The GameKeepr mothership

The receiving end of GameKeepr's **opt-in, anonymous** usage statistics, and
the public statistics page they feed. It is in the open repository on
purpose: anyone can read exactly what happens to a ping.

- `worker.js` — a Cloudflare Worker: `POST /ping` validates and stores a
  payload, `GET /stats` is the public page, `GET /stats.json` the raw
  aggregates. It never reads the caller's IP address. The page's charts are
  hand-rolled inline SVG (a worker ships no chart library) on a palette
  validated for the dark surface, and every value is written as text as well,
  so colour is never the only channel.
- `schema.sql` — one row per install (latest ping wins) plus one aggregate
  row per day. Installs silent for 90 days are swept nightly; only the daily
  aggregates remain.
- `deploy-mothership.sh` — a step-by-step wizard that signs you into
  Cloudflare, creates the D1 database, applies the schema, deploys, verifies,
  and feeds the resulting URL back into the portal's `TELEMETRY_ENDPOINT`.

What a ping contains — every line of it — is documented in
[the wiki's security page](https://kengoossens.github.io/Gamekeep/wiki/security.html)
and shown verbatim in the portal under **Settings → Anonymous usage
statistics** before anyone opts in.
