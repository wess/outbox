import { config } from "@outbox/config"
import {
  contacts,
  contactTopics,
  type Domain,
  domains,
  type Email,
  emailAttachments,
  emailRecipients,
  emails,
  suppressions,
  type Tag,
  templates,
  templateVariables,
  templateVersions,
  topics,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { domainOf, normalizeEmail, parseAddress, toAddressArray } from "../addresses/index.ts"
import { allColumns, db } from "../db/index.ts"
import {
  invalidAttachment,
  invalidFromAddress,
  invalidParameter,
  missingRequiredField,
  notFound,
} from "../errors/index.ts"
import { emit } from "../events/index.ts"
import { rfcMessageId } from "../ids/index.ts"
import { enqueue } from "../queue/index.ts"
import { normalizeSchedule, parseScheduledAt } from "../scheduling/index.ts"
import { render } from "../template/index.ts"

export type AttachmentInput = {
  content?: string | Buffer | number[]
  filename?: string
  path?: string
  content_type?: string
  content_id?: string
}

export type SendInput = {
  from?: string
  to?: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  reply_to?: string | string[]
  subject?: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  tags?: Tag[]
  topic_id?: string
  scheduled_at?: string
  attachments?: AttachmentInput[]
  template?: { id: string; variables?: Record<string, unknown> }
}

export type SendContext = {
  teamId: string
  apiKeyId?: string | null
  idempotencyKey?: string | null
  broadcastId?: string | null
  automationRunId?: string | null
  contactId?: string | null
  // Broadcasts and automations pre-render their bodies and skip template lookup.
  skipTemplate?: boolean
}

const MAX_RECIPIENTS = 50

export const resolveSendingDomain = async (
  teamId: string,
  fromAddress: string,
): Promise<Domain | null> => {
  const parsed = parseAddress(fromAddress)
  if (!parsed) {
    throw invalidFromAddress(
      "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    )
  }
  const host = domainOf(parsed.email)
  return db().one<Domain>(
    from(domains).where((q) => [q("team_id").equals(teamId), q("name").equals(host)]),
  )
}

const decodeAttachment = async (
  att: AttachmentInput,
): Promise<{
  filename: string
  content: Buffer
  contentType: string
  contentId: string | null
}> => {
  if (!att.filename && !att.path) {
    throw invalidAttachment("Each attachment must include a `filename`.")
  }
  let content: Buffer
  if (att.path) {
    const res = await fetch(att.path)
    if (!res.ok) throw invalidAttachment(`Could not fetch attachment from \`path\`: ${att.path}`)
    content = Buffer.from(await res.arrayBuffer())
  } else if (typeof att.content === "string") {
    content = Buffer.from(att.content, "base64")
  } else if (Array.isArray(att.content)) {
    content = Buffer.from(att.content)
  } else if (att.content instanceof Uint8Array) {
    content = Buffer.from(att.content)
  } else {
    throw invalidAttachment("Each attachment must include `content` or `path`.")
  }
  const filename = att.filename ?? att.path!.split("/").pop() ?? "attachment"
  return {
    filename,
    content,
    contentType: att.content_type ?? guessContentType(filename),
    contentId: att.content_id ?? null,
  }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  txt: "text/plain",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
  ics: "text/calendar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

// Extensions rejected outright, matching what receiving MTAs strip anyway.
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "cpl",
  "dll",
  "scr",
  "vbs",
  "vbe",
  "js",
  "jse",
  "jar",
  "msi",
  "msp",
  "pif",
  "reg",
  "sct",
  "wsf",
  "wsh",
  "ade",
  "adp",
  "app",
  "asp",
  "bas",
  "chm",
  "cnt",
  "crt",
  "csh",
  "der",
  "hlp",
  "hpj",
  "ins",
  "isp",
  "its",
  "ksh",
  "lnk",
  "mad",
  "maf",
  "mag",
  "mam",
  "mar",
  "mas",
  "mat",
  "mau",
])

const guessContentType = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

const assertAttachmentAllowed = (filename: string): void => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? ""
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw invalidAttachment(`Attachments with the \`.${ext}\` extension are not supported.`)
  }
}

export const isSuppressed = async (teamId: string, email: string): Promise<boolean> => {
  const row = await db().one<{ id: string }>(
    from(suppressions)
      .select("id")
      .where((q) => [q("team_id").equals(teamId), q("email").equals(normalizeEmail(email))]),
  )
  return Boolean(row)
}

/**
 * Topic gating, per Resend's rules:
 *   contact opted in            -> send
 *   contact opted out           -> skip
 *   not a contact               -> follow the topic's default_subscription
 */
export const allowedByTopic = async (
  teamId: string,
  topicId: string,
  email: string,
): Promise<boolean> => {
  const conn = db()
  const topic = await conn.one<{ default_subscription: string }>(
    from(topics)
      .select("default_subscription")
      .where((q) => [q("id").equals(topicId), q("team_id").equals(teamId)]),
  )
  if (!topic) throw notFound("Topic not found")

  const contact = await conn.one<{ id: string }>(
    from(contacts)
      .select("id")
      .where((q) => [q("team_id").equals(teamId), q("email").equals(normalizeEmail(email))]),
  )
  if (!contact) return topic.default_subscription === "opt_in"

  const sub = await conn.one<{ subscription: string }>(
    from(contactTopics)
      .select("subscription")
      .where((q) => [q("contact_id").equals(contact.id), q("topic_id").equals(topicId)]),
  )
  if (!sub) return topic.default_subscription === "opt_in"
  return sub.subscription === "opt_in"
}

type ResolvedTemplate = {
  templateId: string
  versionId: string
  from: string | null
  subject: string | null
  replyTo: string[] | null
  html: string | null
  text: string | null
}

const resolveTemplate = async (
  teamId: string,
  idOrAlias: string,
  variables: Record<string, unknown>,
): Promise<ResolvedTemplate> => {
  const conn = db()
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrAlias)
  const tpl = await conn.one<{ id: string; current_version_id: string | null }>(
    from(templates)
      .select("id", "current_version_id")
      .where((q) => [
        q("team_id").equals(teamId),
        isUuid ? q("id").equals(idOrAlias) : q("alias").equals(idOrAlias),
      ]),
  )
  if (!tpl) throw notFound("Template not found")
  if (!tpl.current_version_id) {
    throw invalidParameter("Template has no published version. Publish it before sending.")
  }

  const version = await conn.one<{
    id: string
    from_address: string | null
    subject: string | null
    reply_to: string[] | null
    html: string | null
    text: string | null
  }>(from(templateVersions).where((q) => q("id").equals(tpl.current_version_id!)))
  if (!version) throw notFound("Template version not found")

  const declared = await conn.all<{ key: string; fallback_value: string | null }>(
    from(templateVariables)
      .select("key", "fallback_value")
      .where((q) => q("template_version_id").equals(version.id)),
  )
  const fallbacks = Object.fromEntries(declared.map((d) => [d.key, d.fallback_value]))

  return {
    templateId: tpl.id,
    versionId: version.id,
    from: version.from_address,
    subject: version.subject ? render(version.subject, variables, { fallbacks }) : null,
    replyTo: version.reply_to,
    html: version.html ? render(version.html, variables, { fallbacks }) : null,
    text: version.text ? render(version.text, variables, { fallbacks }) : null,
  }
}

export type PreparedSend = { email: Email; skipped?: { reason: string } }

/**
 * Validates, persists, and queues a single email. Returns the stored row so the
 * caller can serialise it. Delivery itself happens in the worker.
 */
export const createEmail = async (input: SendInput, ctx: SendContext): Promise<Email> => {
  const conn = db()

  const template = input.template
    ? await resolveTemplate(ctx.teamId, input.template.id, input.template.variables ?? {})
    : null

  const fromRaw = input.from ?? template?.from ?? null
  if (!fromRaw) throw missingRequiredField("Missing `from` field.")

  const subject = input.subject ?? template?.subject ?? null
  if (subject === null || subject === undefined)
    throw missingRequiredField("Missing `subject` field.")

  const to = toAddressArray(input.to)
  if (to.length === 0) throw missingRequiredField("Missing `to` field.")

  const cc = toAddressArray(input.cc)
  const bcc = toAddressArray(input.bcc)
  const replyTo = toAddressArray(input.reply_to ?? template?.replyTo ?? undefined)

  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw invalidParameter(
      `Too many recipients. A single email supports up to ${MAX_RECIPIENTS} addresses.`,
    )
  }

  const html = input.html ?? template?.html ?? null
  const text = input.text ?? template?.text ?? null
  if (!html && !text) {
    throw missingRequiredField("Missing one of `html`, `text`, or `template`.")
  }

  const domain = await resolveSendingDomain(ctx.teamId, fromRaw)
  // Verified domains are required for real delivery, but the console transport
  // is how people try the product before they own a domain.
  if (!domain && config.transport !== "console") {
    throw invalidFromAddress(
      `The ${domainOf(parseAddress(fromRaw)!.email)} domain is not verified. Add and verify it at /domains.`,
    )
  }
  if (domain && domain.sending !== "enabled") {
    throw invalidFromAddress(`Sending is disabled for the ${domain.name} domain.`)
  }

  const scheduledAt = normalizeSchedule(parseScheduledAt(input.scheduled_at))

  const prepared: {
    filename: string
    content: Buffer
    contentType: string
    contentId: string | null
  }[] = []
  let attachmentBytes = 0
  for (const att of input.attachments ?? []) {
    const decoded = await decodeAttachment(att)
    assertAttachmentAllowed(decoded.filename)
    attachmentBytes += decoded.content.byteLength
    prepared.push(decoded)
  }
  if (attachmentBytes > config.maxAttachmentBytes) {
    throw invalidAttachment(
      `Attachments exceed the ${Math.floor(config.maxAttachmentBytes / 1024 / 1024)}MB limit.`,
    )
  }

  const messageIdValue = rfcMessageId(domain?.name ?? config.hostname)
  const size = Buffer.byteLength(html ?? "") + Buffer.byteLength(text ?? "") + attachmentBytes

  const row = await conn.one<Email>(
    from(emails)
      .insert({
        team_id: ctx.teamId,
        domain_id: domain?.id ?? null,
        message_id: messageIdValue,
        from_address: fromRaw,
        to_addresses: to,
        cc: cc.length ? cc : null,
        bcc: bcc.length ? bcc : null,
        reply_to: replyTo.length ? replyTo : null,
        subject,
        html,
        text,
        headers: input.headers ?? null,
        tags: input.tags?.length ? input.tags : null,
        topic_id: input.topic_id ?? null,
        template_id: template?.templateId ?? null,
        template_version_id: template?.versionId ?? null,
        broadcast_id: ctx.broadcastId ?? null,
        automation_run_id: ctx.automationRunId ?? null,
        api_key_id: ctx.apiKeyId ?? null,
        idempotency_key: ctx.idempotencyKey ?? null,
        last_event: scheduledAt ? "scheduled" : "queued",
        scheduled_at: scheduledAt,
        size_bytes: size,
      })
      .returning(...allColumns(emails)),
  )
  const email = row!

  const recipientRows = [
    ...to.map((address) => ({ address, kind: "to" })),
    ...cc.map((address) => ({ address, kind: "cc" })),
    ...bcc.map((address) => ({ address, kind: "bcc" })),
  ].map((r) => {
    const parsed = parseAddress(r.address)
    return {
      email_id: email.id,
      team_id: ctx.teamId,
      address: parsed?.email ?? r.address,
      kind: r.kind,
      contact_id: ctx.contactId ?? null,
      last_event: scheduledAt ? "scheduled" : "queued",
    }
  })
  if (recipientRows.length) await conn.execute(from(emailRecipients).insertMany(recipientRows))

  if (prepared.length) {
    await conn.execute(
      from(emailAttachments).insertMany(
        prepared.map((a) => ({
          email_id: email.id,
          team_id: ctx.teamId,
          filename: a.filename,
          content_type: a.contentType,
          content_id: a.contentId,
          size: a.content.byteLength,
          content: a.content.toString("base64"),
        })),
      ),
    )
  }

  if (scheduledAt) {
    await emit({
      teamId: ctx.teamId,
      type: "email.scheduled",
      emailId: email.id,
      updateLastEvent: false,
    })
  }
  await enqueue({
    kind: "email.send",
    payload: { emailId: email.id },
    teamId: ctx.teamId,
    runAt: scheduledAt ?? new Date(),
  })

  return email
}
