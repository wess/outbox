import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

export type Tag = { name: string; value: string }

// last_event mirrors the webhook event names without the `email.` prefix:
// queued | scheduled | sent | delivered | delivery_delayed | complained
//       | bounced | opened | clicked | failed | canceled | suppressed
export const emails = defineSchema("emails", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  domain_id: column.uuid().nullable(),
  message_id: column.text().nullable(),
  // `from` / `to` are reserved words in Postgres and @wess/atlas/db emits bare
  // identifiers, so the columns carry a suffix and the API serializer maps them
  // back to Resend's `from` / `to`.
  from_address: column.text(),
  to_addresses: column.json<string[]>(),
  cc: column.json<string[]>().nullable(),
  bcc: column.json<string[]>().nullable(),
  reply_to: column.json<string[]>().nullable(),
  subject: column.text(),
  html: column.text().nullable(),
  text: column.text().nullable(),
  headers: column.json<Record<string, string>>().nullable(),
  tags: column.json<Tag[]>().nullable(),
  topic_id: column.uuid().nullable(),
  template_id: column.uuid().nullable(),
  template_version_id: column.uuid().nullable(),
  broadcast_id: column.uuid().nullable(),
  automation_run_id: column.uuid().nullable(),
  api_key_id: column.uuid().nullable(),
  idempotency_key: column.text().nullable(),
  last_event: column.text().default("queued"),
  scheduled_at: column.timestamp().nullable(),
  sent_at: column.timestamp().nullable(),
  canceled_at: column.timestamp().nullable(),
  size_bytes: column.integer().default(0),
  created_at: now(),
  updated_at: now(),
})

// One row per address so bounces and opens attribute to the right recipient.
// kind: to | cc | bcc
export const emailRecipients = defineSchema("email_recipients", {
  id: id(),
  email_id: column.uuid().ref("emails", "id"),
  team_id: column.uuid(),
  address: column.text(),
  kind: column.text().default("to"),
  contact_id: column.uuid().nullable(),
  last_event: column.text().default("queued"),
  bounce_type: column.text().nullable(),
  created_at: now(),
})

export const emailEvents = defineSchema("email_events", {
  id: id(),
  team_id: column.uuid(),
  email_id: column.uuid().ref("emails", "id"),
  recipient: column.text().nullable(),
  type: column.text(),
  data: column.json<Record<string, unknown>>().nullable(),
  created_at: now(),
})

export const emailAttachments = defineSchema("email_attachments", {
  id: id(),
  email_id: column.uuid().ref("emails", "id"),
  team_id: column.uuid(),
  filename: column.text(),
  content_type: column.text().default("application/octet-stream"),
  content_id: column.text().nullable(),
  size: column.integer().default(0),
  // Exactly one of these carries the bytes: a key when a bucket is configured,
  // inline base64 when it is not.
  content: column.text().nullable(),
  storage_key: column.text().nullable(),
  created_at: now(),
})

export const receivedEmails = defineSchema("received_emails", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  domain_id: column.uuid().nullable(),
  message_id: column.text().nullable(),
  in_reply_to: column.text().nullable(),
  reference_ids: column.json<string[]>().nullable(),
  from_address: column.text(),
  to_addresses: column.json<string[]>(),
  cc: column.json<string[]>().nullable(),
  received_for: column.json<string[]>().nullable(),
  subject: column.text().nullable(),
  html: column.text().nullable(),
  text: column.text().nullable(),
  headers: column.json<Record<string, string>>().nullable(),
  spf: column.text().nullable(),
  dkim: column.text().nullable(),
  dmarc: column.text().nullable(),
  spam_score: column.real().nullable(),
  raw: column.text().nullable(),
  raw_storage_key: column.text().nullable(),
  size_bytes: column.integer().default(0),
  created_at: now(),
})

export const receivedEmailAttachments = defineSchema("received_email_attachments", {
  id: id(),
  received_email_id: column.uuid().ref("received_emails", "id"),
  team_id: column.uuid(),
  filename: column.text(),
  content_type: column.text().default("application/octet-stream"),
  content_id: column.text().nullable(),
  size: column.integer().default(0),
  content: column.text().nullable(),
  storage_key: column.text().nullable(),
  created_at: now(),
})

// Backing store for open pixels and click redirects.
export const trackingLinks = defineSchema("tracking_links", {
  id: id(),
  team_id: column.uuid(),
  email_id: column.uuid().ref("emails", "id"),
  url: column.text(),
  created_at: now(),
})

export type Email = RowOf<typeof emails>
export type EmailRecipient = RowOf<typeof emailRecipients>
export type EmailEvent = RowOf<typeof emailEvents>
export type EmailAttachment = RowOf<typeof emailAttachments>
export type ReceivedEmail = RowOf<typeof receivedEmails>
export type ReceivedEmailAttachment = RowOf<typeof receivedEmailAttachments>
export type TrackingLink = RowOf<typeof trackingLinks>
