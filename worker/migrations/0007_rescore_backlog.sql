-- The same-product model re-scores the links and reviews made before it
-- (catalog.ts rescoreBacklog). This finds the automatic links it hasn't seen
-- yet without reading every listing on every run, then and ever after.
CREATE INDEX IF NOT EXISTS listings_matched ON listings (match_status, matched_at);

-- match_reviews.status gains two values for the model's own calls, kept apart
-- from a person's 'approved' / 'rejected' (which later listings follow):
--   model_same       the model linked it (score >= MODEL.sameFrom)
--   model_different  the model ruled that product out; the listing is matched again
--   stale            the listing had moved on (renamed, matched again) before it was decided
