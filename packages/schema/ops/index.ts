import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// The work queue every worker polls.
// kind: email.send | broadcast.fanout | webhook.deliver | automation.resume
//     | domain.verify | suppression.sweep
// status: pending | running | done | failed
export const jobs = defineSchema("jobs", {
  id: id(),
  team_id: column.uuid().nullable(),
  kind: column.text(),
  payload: column.json<Record<string, unknown>>(),
  status: column.text().default("pending"),
  run_at: now(),
  attempts: column.integer().default(0),
  max_attempts: column.integer().default(5),
  locked_at: column.timestamp().nullable(),
  locked_by: column.text().nullable(),
  last_error: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

export const apiLogs = defineSchema("api_logs", {
  id: id(),
  team_id: column.uuid().nullable(),
  api_key_id: column.uuid().nullable(),
  endpoint: column.text(),
  method: column.text(),
  response_status: column.integer(),
  user_agent: column.text().nullable(),
  ip: column.text().nullable(),
  request_body: column.json<unknown>().nullable(),
  response_body: column.json<unknown>().nullable(),
  duration_ms: column.integer().nullable(),
  created_at: now(),
})

export const idempotencyKeys = defineSchema("idempotency_keys", {
  id: id(),
  team_id: column.uuid(),
  key: column.text(),
  request_hash: column.text(),
  response_status: column.integer().nullable(),
  response_body: column.json<unknown>().nullable(),
  created_at: now(),
  expires_at: column.timestamp(),
})

// Shape required by @wess/atlas/security#createDbRateLimit.
export const rateLimits = defineSchema("rate_limits", {
  bucket: column.text().primaryKey(),
  count: column.integer(),
  window_started_at: column.timestamp(),
})

// Shape required by @wess/atlas/security#createAuditLogger.
export const auditEvents = defineSchema("audit_events", {
  id: column.serial().primaryKey(),
  user_id: column.text().nullable(),
  event: column.text(),
  metadata: column.text().nullable(),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: now(),
})

export type Job = RowOf<typeof jobs>
export type ApiLog = RowOf<typeof apiLogs>
export type IdempotencyKey = RowOf<typeof idempotencyKeys>
