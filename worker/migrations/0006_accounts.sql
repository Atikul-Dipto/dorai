-- Accounts (worker/accounts.ts) and the guest trial (worker/access.ts).

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,    -- lower-cased, not verified
  password_hash TEXT NOT NULL,   -- PBKDF2-SHA256
  password_salt TEXT NOT NULL,
  rounds INTEGER NOT NULL,       -- per user, so the strength can rise later
  recovery_hash TEXT NOT NULL,   -- SHA-256 of the one-time recovery code
  history INTEGER NOT NULL DEFAULT 0,  -- said yes to search history
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 of the cookie's token
  user_id INTEGER NOT NULL,      -- users.id
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- A count per guest cookie, nothing about the searches themselves.
CREATE TABLE guests (
  key TEXT PRIMARY KEY,          -- salted hash of the cookie
  used INTEGER NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX guests_last ON guests (last_at);
