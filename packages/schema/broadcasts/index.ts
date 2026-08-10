import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// status: draft | scheduled | sending | sent | canceled
export const broadcasts = defineSchema("broadcasts", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  segment_id: column.uuid().nullable(),
  topic_id: column.uuid().nullable(),
  name: column.text().nullable(),
  from_address: column.text(),
  subject: column.text(),
  preview_text: column.text().nullable(),
  reply_to: column.json<string[]>().nullable(),
  html: column.text().nullable(),
  text: column.text().nullable(),
  status: column.text().default("draft"),
  scheduled_at: column.timestamp().nullable(),
  sent_at: column.timestamp().nullable(),
  canceled_at: column.timestamp().nullable(),
  total: column.integer().default(0),
  created_at: now(),
  updated_at: now(),
})

// status: pending | sent | skipped
export const broadcastRecipients = defineSchema("broadcast_recipients", {
  id: id(),
  broadcast_id: column.uuid().ref("broadcasts", "id"),
  team_id: column.uuid(),
  contact_id: column.uuid().nullable(),
  email_id: column.uuid().nullable(),
  email: column.text(),
  status: column.text().default("pending"),
  skip_reason: column.text().nullable(),
  created_at: now(),
})

export type Broadcast = RowOf<typeof broadcasts>
export type BroadcastRecipient = RowOf<typeof broadcastRecipients>
