-- The first account created on an instance owns it. A partial unique index
-- makes that a database guarantee rather than an application convention, so two
-- concurrent signups cannot both become owner.
ALTER TABLE users ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX users_single_owner_idx ON users (is_owner) WHERE is_owner;

-- An existing install adopts its earliest account as the owner.
UPDATE users SET is_owner = true
WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1);
