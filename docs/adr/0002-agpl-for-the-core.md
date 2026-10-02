# AGPL-3.0 for the core from v1.2.0

GameKeepr turned out to carry real product value — the curated game registry,
the Steam compose path, the whole portal — and MIT lets anyone, including a
hosting company, take all of it commercial without giving anything back. From
v1.2.0 the core is licensed **AGPL-3.0-or-later**: still genuinely open
source and free to self-host, but anyone offering it as a network service
must publish their modifications, which in practice keeps commercial
freeriders out entirely.

The open-core structure of ADR-0001 is unchanged: paid "plus" features still
live outside this repository. Ken Goossens is the sole copyright holder at
the time of the switch, which is what made it a one-line decision; outside
contributions from here on are accepted under the project licence, and
anything that would constrain a future licensing decision needs a CLA first.

## Consequences

- v1.0.0 and v1.1.0 were published under MIT and remain MIT irrevocably;
  the switch protects future work only.
- A licence does not protect facts (port numbers, launch commands); what it
  deters is wholesale commercial reuse of the codebase.
- README, package.json and the CA profile say AGPL; the LICENSE file carries
  the full text.
