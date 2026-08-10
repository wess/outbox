-- Password reset tokens. Only the hash is stored, so a database backup cannot
-- be turned into working reset links.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookups are by user when rate limiting a flood of requests, and the sweep of
-- expired rows wants the timestamp.
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets (expires_at);
