-- Visitor profiles (worker/profiles.ts): one shopper's searches and what they
-- did with the answers, linked, only when they said yes on the page. `visitor`
-- is a salted hash of a random id kept in their browser; it stays empty for
-- everyone else, whose rows are as anonymous as before.

ALTER TABLE asks ADD COLUMN visitor TEXT;
ALTER TABLE interactions ADD COLUMN visitor TEXT;
CREATE INDEX asks_visitor ON asks (visitor, asked_at) WHERE visitor IS NOT NULL;
CREATE INDEX interactions_visitor ON interactions (visitor, at) WHERE visitor IS NOT NULL;
