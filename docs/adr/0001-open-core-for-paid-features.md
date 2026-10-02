# Open-core: paid features live outside the MIT repo

GameKeepr is MIT-licensed, public on GitHub, and listed in the Unraid
Community Applications catalog as a free app — promises we don't want to walk
back. To still support a paid tier, we chose **open-core**: everything in this
repository stays free and MIT (including the entire tournaments feature),
while paid "plus" features (white-labeling of the public Tournament Page
first) live in a separate, non-public module unlocked by a license key.

## Considered Options

- **License switch** (BSL / Fair Source for new code): legally possible, but
  it changes the project's character right after launching in the CA catalog
  as a free MIT app.
- **Hosted service** (self-hosting free, paid cloud variant): doesn't fit a
  product whose pitch is "your servers, your machine".

## Consequences

- Free features must never import from the plus module; the boundary is a
  theme/extension slot, not scattered `if (paid)` checks. The public
  Tournament Page ships with branding as a swappable theme layer so
  white-labeling fills a slot instead of forcing a refactor.
- The license-key mechanism is deliberately **not** part of tournaments v1;
  it is its own project.
