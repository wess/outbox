-- Outbound connections to other services this team has paired with.
-- One row per provider per team: pairing again replaces the credential rather
-- than accumulating duplicates nobody can tell apart.
CREATE TABLE integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  settings JSONB,
  status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, provider)
);
CREATE INDEX integrations_team_idx ON integrations (team_id, created_at DESC);
