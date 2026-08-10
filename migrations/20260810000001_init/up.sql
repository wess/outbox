CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- accounts --

CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  avatar_url TEXT,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  backup_codes JSONB,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invites_team_idx ON invites (team_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'full_access',
  domain_id UUID,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_team_idx ON api_keys (team_id, created_at DESC);

-- ----------------------------------------------------------------- domains --

CREATE TABLE domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  region TEXT NOT NULL DEFAULT 'us-east-1',
  open_tracking BOOLEAN NOT NULL DEFAULT false,
  click_tracking BOOLEAN NOT NULL DEFAULT false,
  tracking_subdomain TEXT NOT NULL DEFAULT 'links',
  tls TEXT NOT NULL DEFAULT 'opportunistic',
  custom_return_path TEXT NOT NULL DEFAULT 'send',
  sending TEXT NOT NULL DEFAULT 'enabled',
  receiving TEXT NOT NULL DEFAULT 'disabled',
  dkim_selector TEXT NOT NULL DEFAULT 'outbox',
  dkim_private_key TEXT,
  dkim_public_key TEXT,
  verified_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

CREATE TABLE domain_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  record TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  ttl TEXT NOT NULL DEFAULT 'Auto',
  priority INTEGER,
  status TEXT NOT NULL DEFAULT 'not_started',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX domain_records_domain_idx ON domain_records (domain_id);

ALTER TABLE api_keys ADD CONSTRAINT api_keys_domain_fk
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- audience --

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  unsubscribed BOOLEAN NOT NULL DEFAULT false,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);
CREATE INDEX contacts_team_created_idx ON contacts (team_id, created_at DESC);

CREATE TABLE contact_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string',
  fallback_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, key)
);

CREATE TABLE contact_property_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES contact_properties(id) ON DELETE CASCADE,
  value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, property_id)
);
CREATE INDEX contact_property_values_property_idx ON contact_property_values (property_id);

CREATE TABLE segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX segments_team_idx ON segments (team_id, created_at DESC);

CREATE TABLE segment_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (segment_id, contact_id)
);
CREATE INDEX segment_contacts_contact_idx ON segment_contacts (contact_id);

CREATE TABLE topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  default_subscription TEXT NOT NULL DEFAULT 'opt_in',
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX topics_team_idx ON topics (team_id, created_at DESC);

CREATE TABLE contact_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, topic_id)
);
CREATE INDEX contact_topics_topic_idx ON contact_topics (topic_id);

CREATE TABLE suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'manual',
  source_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, email)
);
CREATE INDEX suppressions_team_created_idx ON suppressions (team_id, created_at DESC);

-- --------------------------------------------------------------- templates --

CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  alias TEXT,
  current_version_id UUID,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, alias)
);
CREATE INDEX templates_team_idx ON templates (team_id, created_at DESC);

CREATE TABLE template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  from_address TEXT,
  subject TEXT,
  reply_to JSONB,
  html TEXT,
  text TEXT,
  published_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

ALTER TABLE templates ADD CONSTRAINT templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES template_versions(id) ON DELETE SET NULL;

CREATE TABLE template_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id UUID NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
  template_id UUID NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'string',
  fallback_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_version_id, key)
);

-- -------------------------------------------------------------- broadcasts --

CREATE TABLE broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  segment_id UUID REFERENCES segments(id) ON DELETE SET NULL,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  name TEXT,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  preview_text TEXT,
  reply_to JSONB,
  html TEXT,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX broadcasts_team_idx ON broadcasts (team_id, created_at DESC);

-- ------------------------------------------------------------------ emails --

CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
  message_id TEXT,
  from_address TEXT NOT NULL,
  to_addresses JSONB NOT NULL,
  cc JSONB,
  bcc JSONB,
  reply_to JSONB,
  subject TEXT NOT NULL,
  html TEXT,
  text TEXT,
  headers JSONB,
  tags JSONB,
  topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  template_version_id UUID,
  broadcast_id UUID REFERENCES broadcasts(id) ON DELETE SET NULL,
  automation_run_id UUID,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  last_event TEXT NOT NULL DEFAULT 'queued',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_team_created_idx ON emails (team_id, created_at DESC);
CREATE INDEX emails_broadcast_idx ON emails (broadcast_id) WHERE broadcast_id IS NOT NULL;
CREATE INDEX emails_scheduled_idx ON emails (scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE UNIQUE INDEX emails_idempotency_idx ON emails (team_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE email_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  address TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'to',
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  last_event TEXT NOT NULL DEFAULT 'queued',
  bounce_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_recipients_email_idx ON email_recipients (email_id);
CREATE INDEX email_recipients_address_idx ON email_recipients (team_id, address);

CREATE TABLE email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  recipient TEXT,
  type TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_events_email_idx ON email_events (email_id, created_at);
CREATE INDEX email_events_team_type_idx ON email_events (team_id, type, created_at DESC);

CREATE TABLE email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_attachments_email_idx ON email_attachments (email_id);

CREATE TABLE received_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
  message_id TEXT,
  in_reply_to TEXT,
  reference_ids JSONB,
  from_address TEXT NOT NULL,
  to_addresses JSONB NOT NULL,
  cc JSONB,
  received_for JSONB,
  subject TEXT,
  html TEXT,
  text TEXT,
  headers JSONB,
  spf TEXT,
  dkim TEXT,
  dmarc TEXT,
  spam_score DOUBLE PRECISION,
  raw TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX received_emails_team_created_idx ON received_emails (team_id, created_at DESC);

CREATE TABLE received_email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_email_id UUID NOT NULL REFERENCES received_emails(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX received_email_attachments_email_idx
  ON received_email_attachments (received_email_id);

CREATE TABLE tracking_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tracking_links_email_idx ON tracking_links (email_id);

CREATE TABLE broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  email_id UUID REFERENCES emails(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX broadcast_recipients_broadcast_idx ON broadcast_recipients (broadcast_id);

-- ---------------------------------------------------------------- webhooks --

CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  events JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  signing_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_team_idx ON webhooks (team_id, created_at DESC);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  team_id UUID NOT NULL,
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_webhook_idx ON webhook_events (webhook_id, created_at DESC);
CREATE INDEX webhook_events_pending_idx ON webhook_events (next_attempt_at)
  WHERE status = 'pending';

CREATE TABLE webhook_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  webhook_id UUID NOT NULL,
  http_status_code INTEGER,
  response TEXT,
  error TEXT,
  duration_ms INTEGER,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_attempts_event_idx ON webhook_attempts (webhook_event_id, sent_at);

-- ------------------------------------------------------------- automations --

CREATE TABLE automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'disabled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automations_team_idx ON automations (team_id, created_at DESC);

CREATE TABLE automation_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  config JSONB,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (automation_id, key)
);

CREATE TABLE automation_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automation_edges_automation_idx ON automation_edges (automation_id);

CREATE TABLE automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  team_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  current_step_key TEXT,
  resume_at TIMESTAMPTZ,
  waiting_for_event TEXT,
  context JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
CREATE INDEX automation_runs_resume_idx ON automation_runs (resume_at)
  WHERE status = 'waiting';

CREATE TABLE automation_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automation_run_steps_run_idx ON automation_run_steps (run_id, created_at);

CREATE TABLE custom_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, name)
);

CREATE TABLE event_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  contact_id UUID,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX event_deliveries_team_idx ON event_deliveries (team_id, created_at DESC);

-- ---------------------------------------------------------------------- ops --

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_at) WHERE status = 'pending';

CREATE TABLE api_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID,
  api_key_id UUID,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  user_agent TEXT,
  ip TEXT,
  request_body JSONB,
  response_body JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_logs_team_created_idx ON api_logs (team_id, created_at DESC);

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (team_id, key)
);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_events (
  id SERIAL PRIMARY KEY,
  user_id TEXT,
  event TEXT NOT NULL,
  metadata TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
