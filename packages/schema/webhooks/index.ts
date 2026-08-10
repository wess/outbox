import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// status: enabled | disabled
export const webhooks = defineSchema("webhooks", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  endpoint: column.text(),
  events: column.json<string[]>(),
  status: column.text().default("enabled"),
  signing_secret: column.text(),
  created_at: now(),
  updated_at: now(),
})

// id is a Svix-style `msg_<base62>` string, not a UUID.
// status: pending | delivered | failed | exhausted
export const webhookEvents = defineSchema("webhook_events", {
  id: column.text().primaryKey(),
  team_id: column.uuid(),
  webhook_id: column.uuid().ref("webhooks", "id"),
  type: column.text(),
  payload: column.json<Record<string, unknown>>(),
  status: column.text().default("pending"),
  attempts: column.integer().default(0),
  next_attempt_at: column.timestamp().nullable(),
  delivered_at: column.timestamp().nullable(),
  created_at: now(),
})

export const webhookAttempts = defineSchema("webhook_attempts", {
  id: id(),
  webhook_event_id: column.text().ref("webhook_events", "id"),
  webhook_id: column.uuid(),
  http_status_code: column.integer().nullable(),
  response: column.text().nullable(),
  error: column.text().nullable(),
  duration_ms: column.integer().nullable(),
  sent_at: now(),
})

export type Webhook = RowOf<typeof webhooks>
export type WebhookEvent = RowOf<typeof webhookEvents>
export type WebhookAttempt = RowOf<typeof webhookAttempts>
