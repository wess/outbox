import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

export const teams = defineSchema("teams", {
  id: id(),
  name: column.text(),
  slug: column.text().unique(),
  created_at: now(),
  updated_at: now(),
})

export const users = defineSchema("users", {
  id: id(),
  email: column.text().unique(),
  password_hash: column.text().nullable(),
  name: column.text().nullable(),
  avatar_url: column.text().nullable(),
  totp_secret: column.text().nullable(),
  totp_enabled: column.boolean().default(false),
  // The first account created on the instance owns it. Enforced by a partial
  // unique index, so there is exactly one.
  is_owner: column.boolean().default(false),
  backup_codes: column.json<string[]>().nullable(),
  email_verified_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

// role: owner | admin | member
export const memberships = defineSchema("memberships", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  user_id: column.uuid().ref("users", "id"),
  role: column.text().default("member"),
  created_at: now(),
})

export const invites = defineSchema("invites", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  email: column.text(),
  role: column.text().default("member"),
  token: column.text().unique(),
  invited_by: column.uuid().nullable(),
  expires_at: column.timestamp(),
  accepted_at: column.timestamp().nullable(),
  created_at: now(),
})

// Mirrors the shape @wess/atlas/security#createSessionStore expects.
export const sessions = defineSchema("sessions", {
  id: column.text().primaryKey(),
  user_id: column.uuid().ref("users", "id"),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: now(),
  last_used_at: column.timestamp().nullable(),
  expires_at: column.timestamp(),
  revoked_at: column.timestamp().nullable(),
})

// permission: full_access | sending_access
export const apiKeys = defineSchema("api_keys", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  permission: column.text().default("full_access"),
  domain_id: column.uuid().nullable(),
  token_hash: column.text().unique(),
  token_prefix: column.text(),
  created_by: column.uuid().nullable(),
  last_used_at: column.timestamp().nullable(),
  created_at: now(),
})

export type Team = RowOf<typeof teams>
export type User = RowOf<typeof users>
export type Membership = RowOf<typeof memberships>
export type Invite = RowOf<typeof invites>
export type Session = RowOf<typeof sessions>
export type ApiKey = RowOf<typeof apiKeys>
