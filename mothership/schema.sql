-- The mothership's whole memory: one row per install (latest ping wins) and
-- one aggregate row per day. No IP addresses are stored anywhere — the worker
-- never reads them — and raw pings older than 90 days are swept, leaving only
-- the daily aggregates.

CREATE TABLE IF NOT EXISTS installs (
  install TEXT PRIMARY KEY,          -- the random id the portal generated
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  servers INTEGER NOT NULL,
  games TEXT NOT NULL,               -- JSON: {"Valheim": 1, ...}
  features TEXT NOT NULL,            -- JSON: {"tournaments": true, ...}
  first_seen INTEGER NOT NULL,       -- ms epoch
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily (
  day TEXT PRIMARY KEY,              -- YYYY-MM-DD (UTC)
  installs INTEGER NOT NULL,         -- distinct installs seen that day
  servers INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs (last_seen);
