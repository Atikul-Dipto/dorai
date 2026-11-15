-- Each shop's last self-check, and the database's (worker/health.ts): one row
-- each, overwritten every check. Read by /api/pp/health.
CREATE TABLE health (
  site          TEXT PRIMARY KEY,            -- daraz · cartup · othoba · startech · pickaboo · database
  ok            INTEGER NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',    -- what was wrong, when something was
  checked_at    TEXT NOT NULL,
  failing_since TEXT,                        -- the first failed check of the current run of failures
  fails         INTEGER NOT NULL DEFAULT 0,  -- failed checks in a row
  alerted       INTEGER NOT NULL DEFAULT 0   -- 1 once the owner was told about this run of failures
);
