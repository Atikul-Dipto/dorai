-- The product matching engine's catalogue (worker/catalog.ts), 2026-11-03.
-- Every listing is parsed, fingerprinted and matched to a canonical product;
-- uncertain matches wait in match_reviews for a person.

-- Offers: what the pipeline reads and records per listing.
ALTER TABLE listings ADD COLUMN brand TEXT;          -- the store's own brand field
ALTER TABLE listings ADD COLUMN image TEXT;
ALTER TABLE listings ADD COLUMN photo_id TEXT;       -- the 32-hex photo file id copies share across stores
ALTER TABLE listings ADD COLUMN fingerprint TEXT;    -- brand + model (or identity words) + specs
ALTER TABLE listings ADD COLUMN match_status TEXT;   -- NULL: not processed yet · new · auto · review · manual
ALTER TABLE listings ADD COLUMN match_score REAL;    -- the confidence of its match, 0..1
ALTER TABLE listings ADD COLUMN matched_at TEXT;
CREATE INDEX listings_unmatched ON listings (match_status, last_seen);
CREATE INDEX listings_fingerprint ON listings (fingerprint);
CREATE INDEX listings_photo ON listings (photo_id);

-- Canonical products. The few made by the earlier ad hoc linker are dropped:
-- the pipeline rebuilds the catalogue from every listing.
UPDATE listings SET product_id = NULL;
DELETE FROM products;
ALTER TABLE products ADD COLUMN brand TEXT;          -- as the store wrote it, for showing
ALTER TABLE products ADD COLUMN brand_key TEXT;      -- normalized, for finding candidates
ALTER TABLE products ADD COLUMN words TEXT NOT NULL DEFAULT '';   -- identity words, space separated
ALTER TABLE products ADD COLUMN fingerprint TEXT;
ALTER TABLE products ADD COLUMN image TEXT;
ALTER TABLE products ADD COLUMN specs TEXT NOT NULL DEFAULT '{}';
CREATE INDEX products_model ON products (model);
CREATE INDEX products_brand ON products (brand_key);

-- Manual review: a listing whose best candidate scored medium or low.
CREATE TABLE match_reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  level      TEXT NOT NULL,     -- medium | low
  reasons    TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX match_reviews_pending ON match_reviews (status, created_at);
CREATE INDEX match_reviews_item ON match_reviews (item_id, status);
