DROP INDEX IF EXISTS users_single_owner_idx;
ALTER TABLE users DROP COLUMN IF EXISTS is_owner;
