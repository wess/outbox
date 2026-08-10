import type {
  ApiKey,
  ApiLog,
  Broadcast,
  Contact,
  ContactProperty,
  Domain,
  DomainRecord,
  Email,
  ReceivedEmail,
  Segment,
  Suppression,
  Template,
  TemplateVariable,
  TemplateVersion,
  Topic,
  Webhook,
  WebhookAttempt,
  WebhookEvent,
} from "@outbox/schema"

// Resend renders timestamps as `2026-04-03 22:13:42.674981+00`, not ISO 8601.
export const pgTimestamp = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const date = typeof d === "string" ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return null
  return `${date.toISOString().replace("T", " ").replace("Z", "")}+00`
}

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const date = typeof d === "string" ? new Date(d) : d
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const emailObject = (row: Email, opts: { full?: boolean } = {}) => {
  const base = {
    object: "email" as const,
    id: row.id,
    message_id: row.message_id,
    to: row.to_addresses ?? [],
    from: row.from_address,
    created_at: pgTimestamp(row.created_at),
    subject: row.subject,
    bcc: row.bcc ?? [],
    cc: row.cc ?? [],
    reply_to: row.reply_to ?? [],
    last_event: row.last_event,
    scheduled_at: pgTimestamp(row.scheduled_at),
  }
  if (!opts.full) return base
  return { ...base, html: row.html, text: row.text, tags: row.tags ?? [] }
}

// The list endpoint returns null (not []) for empty cc/bcc/reply_to.
export const emailListItem = (row: Email) => ({
  id: row.id,
  message_id: row.message_id,
  to: row.to_addresses ?? [],
  from: row.from_address,
  created_at: pgTimestamp(row.created_at),
  subject: row.subject,
  bcc: row.bcc?.length ? row.bcc : null,
  cc: row.cc?.length ? row.cc : null,
  reply_to: row.reply_to?.length ? row.reply_to : null,
  last_event: row.last_event,
  scheduled_at: pgTimestamp(row.scheduled_at),
})

export const receivedEmailObject = (row: ReceivedEmail) => ({
  object: "received_email" as const,
  id: row.id,
  message_id: row.message_id,
  from: row.from_address,
  to: row.to_addresses ?? [],
  cc: row.cc ?? [],
  received_for: row.received_for ?? [],
  subject: row.subject,
  html: row.html,
  text: row.text,
  headers: row.headers ?? {},
  spf: row.spf,
  dkim: row.dkim,
  dmarc: row.dmarc,
  created_at: pgTimestamp(row.created_at),
})

export const domainObject = (row: Domain, records: DomainRecord[] = []) => ({
  object: "domain" as const,
  id: row.id,
  name: row.name,
  status: row.status,
  created_at: pgTimestamp(row.created_at),
  region: row.region,
  open_tracking: row.open_tracking,
  click_tracking: row.click_tracking,
  tracking_subdomain: row.tracking_subdomain,
  tls: row.tls,
  custom_return_path: row.custom_return_path,
  capabilities: { sending: row.sending, receiving: row.receiving },
  records: records.map(domainRecordObject),
})

export const domainRecordObject = (row: DomainRecord) => ({
  record: row.record,
  name: row.name,
  type: row.type,
  ttl: row.ttl,
  status: row.status,
  value: row.value,
  ...(row.priority !== null ? { priority: row.priority } : {}),
})

export const domainListItem = (row: Domain) => ({
  id: row.id,
  name: row.name,
  status: row.status,
  created_at: pgTimestamp(row.created_at),
  region: row.region,
})

export const apiKeyObject = (row: ApiKey) => ({
  id: row.id,
  name: row.name,
  created_at: pgTimestamp(row.created_at),
})

export const contactObject = (row: Contact, properties: Record<string, unknown> = {}) => ({
  object: "contact" as const,
  id: row.id,
  email: row.email,
  first_name: row.first_name,
  last_name: row.last_name,
  created_at: pgTimestamp(row.created_at),
  unsubscribed: row.unsubscribed,
  properties,
})

export const contactPropertyObject = (row: ContactProperty) => ({
  object: "contact_property" as const,
  id: row.id,
  key: row.key,
  type: row.type,
  fallback_value:
    row.type === "number" && row.fallback_value !== null
      ? Number(row.fallback_value)
      : row.fallback_value,
  created_at: pgTimestamp(row.created_at),
  updated_at: pgTimestamp(row.updated_at),
})

export const segmentObject = (row: Segment) => ({
  object: "segment" as const,
  id: row.id,
  name: row.name,
  created_at: pgTimestamp(row.created_at),
})

export const topicObject = (row: Topic) => ({
  object: "topic" as const,
  id: row.id,
  name: row.name,
  description: row.description,
  default_subscription: row.default_subscription,
  visibility: row.visibility,
  created_at: pgTimestamp(row.created_at),
})

export const suppressionObject = (row: Suppression) => ({
  id: row.id,
  email: row.email,
  origin: row.origin,
  source_id: row.source_id,
  created_at: pgTimestamp(row.created_at),
})

export const broadcastObject = (row: Broadcast) => ({
  object: "broadcast" as const,
  id: row.id,
  name: row.name,
  // `audience_id` is the pre-Segments name, kept so older SDKs keep working.
  audience_id: row.segment_id,
  segment_id: row.segment_id,
  from: row.from_address,
  subject: row.subject,
  reply_to: row.reply_to?.length ? row.reply_to : null,
  preview_text: row.preview_text,
  html: row.html,
  text: row.text,
  status: row.status,
  created_at: pgTimestamp(row.created_at),
  scheduled_at: pgTimestamp(row.scheduled_at),
  sent_at: pgTimestamp(row.sent_at),
  topic_id: row.topic_id,
})

export const broadcastListItem = (row: Broadcast) => ({
  id: row.id,
  audience_id: row.segment_id,
  segment_id: row.segment_id,
  status: row.status,
  created_at: pgTimestamp(row.created_at),
  scheduled_at: pgTimestamp(row.scheduled_at),
  sent_at: pgTimestamp(row.sent_at),
})

export const templateVariableObject = (row: TemplateVariable) => ({
  id: row.id,
  key: row.key,
  type: row.type,
  fallback_value:
    row.type === "number" && row.fallback_value !== null
      ? Number(row.fallback_value)
      : row.fallback_value,
  created_at: pgTimestamp(row.created_at),
  updated_at: pgTimestamp(row.updated_at),
})

export const templateObject = (
  row: Template,
  version: TemplateVersion | null,
  variables: TemplateVariable[] = [],
  hasUnpublished = false,
) => ({
  object: "template" as const,
  id: row.id,
  current_version_id: row.current_version_id,
  alias: row.alias,
  name: row.name,
  created_at: pgTimestamp(row.created_at),
  updated_at: pgTimestamp(row.updated_at),
  status: row.status,
  published_at: pgTimestamp(row.published_at),
  from: version?.from_address ?? null,
  subject: version?.subject ?? null,
  reply_to: version?.reply_to?.length ? version.reply_to : null,
  html: version?.html ?? null,
  text: version?.text ?? null,
  variables: variables.map(templateVariableObject),
  has_unpublished_versions: hasUnpublished,
})

export const webhookObject = (row: Webhook) => ({
  object: "webhook" as const,
  id: row.id,
  endpoint: row.endpoint,
  events: row.events ?? [],
  status: row.status,
  signing_secret: row.signing_secret,
  created_at: pgTimestamp(row.created_at),
  updated_at: pgTimestamp(row.updated_at),
})

export const webhookEventObject = (row: WebhookEvent, withPayload = false) => ({
  object: "event" as const,
  id: row.id,
  type: row.type,
  created_at: iso(row.created_at),
  status: row.status,
  next_attempt_at: iso(row.next_attempt_at),
  ...(withPayload ? { payload: row.payload } : {}),
})

export const webhookAttemptObject = (row: WebhookAttempt) => ({
  object: "attempt" as const,
  id: row.id,
  http_status_code: row.http_status_code,
  response: row.response,
  sent_at: iso(row.sent_at),
})

export const logObject = (row: ApiLog, full = false) => ({
  object: "log" as const,
  id: row.id,
  created_at: pgTimestamp(row.created_at),
  endpoint: row.endpoint,
  method: row.method,
  response_status: row.response_status,
  user_agent: row.user_agent,
  ...(full ? { request_body: row.request_body, response_body: row.response_body } : {}),
})
