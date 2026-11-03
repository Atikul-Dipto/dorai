-- What shoppers do with an answer, for the agent to learn from
-- (worker/interactions.ts, /api/pp/events). No visitor information: no
-- address, device or account; the search, the offer, the act and when.

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,         -- open (went to the store) · save · unsave · not_this
  query TEXT NOT NULL,        -- the search as typed, as in asks.query
  item_id TEXT NOT NULL,      -- the offer (listings.item_id)
  site TEXT NOT NULL,         -- daraz · cartup · othoba
  slot TEXT NOT NULL,         -- pick (a store's recommended option) · match (its "More" rows)
  relation TEXT,              -- for a match: same · variant · close · fits …
  position INTEGER NOT NULL,  -- 0 for the pick, then its row in "More"
  price REAL,                 -- as shown
  product_id INTEGER          -- the canonical product the offer was linked to then, if any
);
CREATE INDEX IF NOT EXISTS interactions_at ON interactions (at);
CREATE INDEX IF NOT EXISTS interactions_query ON interactions (query, kind);
CREATE INDEX IF NOT EXISTS interactions_item ON interactions (item_id, kind);
