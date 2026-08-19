-- Fork: per-owner scheduling settings (peak-pricing windows for relay quota
-- gating). `scheduling` holds a JSON SchedulingSettings payload; absent row =
-- shared defaults. Delivered to daemons via the machine heartbeat response.
CREATE TABLE IF NOT EXISTS owner_settings (
  owner_id TEXT PRIMARY KEY,
  scheduling TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
