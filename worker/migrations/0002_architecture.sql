-- DorAI architecture, step 2 (2026-11-03): the data layer of the
-- architecture diagram in D1. D1 (SQLite) plays the diagram's PostgreSQL
-- role: products, offers and users, beside price history and the caches.

-- ---------------------------------------------------------------------------
-- Recorded for completeness: the name-index tables the Python indexers build
-- (agent/cartup_index.py, agent/othoba_index.py). They already exist in the
-- live database, hence IF NOT EXISTS. Rebuilt weekly from this PC.
CREATE TABLE IF NOT EXISTS cartup_docs (block INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cartup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cartup_postings (shard INTEGER NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (shard, part));
CREATE TABLE IF NOT EXISTS othoba_docs (block INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS othoba_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS othoba_postings (shard INTEGER NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (shard, part));

-- ---------------------------------------------------------------------------
-- Products and offers. Each row of `listings` is one store's offer (a Daraz
-- item, a Cartup or Othoba product page). A product groups the offers the
-- matching engine found to be the same thing across stores.
CREATE TABLE products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,  -- the name it was first matched under
  model      TEXT,           -- its main model code, when it has one
  photo_id   TEXT,           -- the 32-hex photo file id copies share across stores
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE listings ADD COLUMN product_id INTEGER REFERENCES products (id);
CREATE INDEX listings_product ON listings (product_id);

-- ---------------------------------------------------------------------------
-- Users: anonymous devices, no accounts and no personal details. A device
-- proves itself with a random token it keeps; only the token's SHA-256 is
-- stored. Push and Telegram details exist only once the shopper turns
-- alerts on.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  lang          TEXT NOT NULL DEFAULT 'bn',
  push_endpoint TEXT,
  telegram_chat TEXT,
  created_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

-- A device's saved products (its server-side watchlist).
CREATE TABLE watches (
  device_id     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,
  site          TEXT NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  image         TEXT NOT NULL DEFAULT '',
  saved_price   REAL NOT NULL,
  target_price  REAL,           -- alert at or below this; NULL: any real drop
  last_price    REAL,
  last_checked  TEXT,
  alerted_price REAL,           -- the price the last alert was about, so each drop is told once
  created_at    TEXT NOT NULL,
  PRIMARY KEY (device_id, item_id)
);
CREATE INDEX watches_item ON watches (item_id);

-- Price-drop alerts, as sent; a device's push notification reads its unseen ones.
CREATE TABLE alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  site            TEXT NOT NULL,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  old_price       REAL NOT NULL,
  new_price       REAL NOT NULL,
  created_at      TEXT NOT NULL,
  seen_at         TEXT,
  push_status     TEXT,         -- sent | gone | failed | NULL (no push)
  telegram_status TEXT          -- sent | failed | NULL (not linked)
);
CREATE INDEX alerts_device ON alerts (device_id, created_at);

-- One-time codes that link a device to a Telegram chat (/start <code>).
CREATE TABLE telegram_links (
  code       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- The task queue the scheduled jobs drain (jobs/). One pending task per
-- kind + key, so a product watched by many devices is checked once.
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,     -- check_price
  key        TEXT NOT NULL,     -- what it's about: an item id
  payload    TEXT NOT NULL DEFAULT '{}',
  run_after  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_one_pending ON tasks (kind, key) WHERE status = 'pending';
CREATE INDEX tasks_due ON tasks (status, run_after);

-- Fixed-window counters for the write endpoints (device sign-up, watchlist
-- changes), keyed by a salted hash of the caller, never the address itself.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
