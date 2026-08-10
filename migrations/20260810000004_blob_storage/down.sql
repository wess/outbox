-- Dropping these strands any blob that was written to the bucket. The objects
-- survive, but nothing records where they belong. Export before rolling back if
-- object storage was ever switched on.
ALTER TABLE email_attachments DROP COLUMN IF EXISTS storage_key;
ALTER TABLE received_email_attachments DROP COLUMN IF EXISTS storage_key;
ALTER TABLE received_emails DROP COLUMN IF EXISTS raw_storage_key;
