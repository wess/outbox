-- Attachments and stored raw MIME move to object storage when a bucket is
-- configured. Existing rows keep their inline content and stay readable: the
-- read path picks whichever column is populated, so this is additive and needs
-- no backfill.
ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE received_email_attachments ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE received_emails ADD COLUMN IF NOT EXISTS raw_storage_key text;
