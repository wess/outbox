import { createHmac, timingSafeEqual } from "node:crypto"
import { emailEvents, emails, type Webhook, webhookEvents, webhooks } from "@outbox/schema"
import { from, raw } from "@wess/atlas/db"
import { db } from "../db/index.ts"
import { messageId } from "../ids/index.ts"
import { enqueue } from "../queue/index.ts"

export const EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const isEventType = (value: string): value is EventType =>
  (EVENT_TYPES as readonly string[]).includes(value)

// Webhook payloads carry tags as an object map, while the email API takes and
// returns them as an array of {name, value}.
const tagsToMap = (
  tags: { name: string; value: string }[] | null,
): Record<string, string> | undefined => {
  if (!tags?.length) return undefined
  return Object.fromEntries(tags.map((t) => [t.name, t.value]))
}

export type EmitOptions = {
  teamId: string
  type: EventType
  emailId?: string | null
  recipient?: string | null
  data?: Record<string, unknown>
  // last_event only moves forward for delivery-state events; opens and clicks
  // must not overwrite a later bounce.
  updateLastEvent?: boolean
}

const _TERMINAL = new Set(["bounced", "failed", "complained", "canceled", "suppressed"])

export const emit = async (opts: EmitOptions): Promise<void> => {
  const conn = db()
  const short = opts.type.replace(/^email\./, "")

  if (opts.emailId) {
    await conn.execute(
      from(emailEvents).insert({
        team_id: opts.teamId,
        email_id: opts.emailId,
        recipient: opts.recipient ?? null,
        type: opts.type,
        data: opts.data ?? null,
      }),
    )

    if (opts.updateLastEvent !== false && opts.type.startsWith("email.")) {
      // Never downgrade a terminal state.
      await conn.execute({
        text: `UPDATE emails SET last_event = $2, updated_at = now()
               WHERE id = $1 AND last_event NOT IN ('bounced','failed','complained','canceled','suppressed')`,
        values: [opts.emailId, short],
      })
      if (opts.recipient) {
        await conn.execute({
          text: `UPDATE email_recipients SET last_event = $3
                 WHERE email_id = $1 AND address = $2
                   AND last_event NOT IN ('bounced','failed','complained','canceled','suppressed')`,
          values: [opts.emailId, opts.recipient, short],
        })
      }
    }
  }

  await dispatch(opts.teamId, opts.type, await payloadFor(opts))
}

const payloadFor = async (opts: EmitOptions): Promise<Record<string, unknown>> => {
  if (!opts.emailId) return { ...(opts.data ?? {}) }
  const email = await db().one<{
    id: string
    message_id: string | null
    from_address: string
    to_addresses: string[]
    subject: string
    created_at: Date
    broadcast_id: string | null
    template_id: string | null
    tags: { name: string; value: string }[] | null
  }>(
    from(emails)
      .select(
        "id",
        "message_id",
        "from_address",
        "to_addresses",
        "subject",
        "created_at",
        "broadcast_id",
        "template_id",
        "tags",
      )
      .where((q) => q("id").equals(opts.emailId!)),
  )
  if (!email) return { ...(opts.data ?? {}) }
  return {
    email_id: email.id,
    message_id: email.message_id,
    from: email.from_address,
    to: email.to_addresses,
    subject: email.subject,
    created_at: email.created_at,
    ...(email.broadcast_id ? { broadcast_id: email.broadcast_id } : {}),
    ...(email.template_id ? { template_id: email.template_id } : {}),
    ...(tagsToMap(email.tags) ? { tags: tagsToMap(email.tags) } : {}),
    ...(opts.data ?? {}),
  }
}

// Queues one webhook_event row per subscribed endpoint, then a delivery job.
export const dispatch = async (
  teamId: string,
  type: EventType,
  data: Record<string, unknown>,
): Promise<void> => {
  const conn = db()
  const hooks = await conn.all<Webhook>(
    from(webhooks).where((q) => [q("team_id").equals(teamId), q("status").equals("enabled")]),
  )
  const matching = hooks.filter((h) => (h.events ?? []).includes(type))
  if (matching.length === 0) return

  const payload = { type, created_at: new Date().toISOString(), data }

  for (const hook of matching) {
    const id = messageId()
    await conn.execute(
      from(webhookEvents).insert({
        id,
        team_id: teamId,
        webhook_id: hook.id,
        type,
        payload,
        status: "pending",
        next_attempt_at: new Date(),
      }),
    )
    await enqueue({ kind: "webhook.deliver", payload: { eventId: id }, teamId })
  }
}

// ---------------------------------------------------------------- signing --

const secretKey = (signingSecret: string): Buffer =>
  Buffer.from(signingSecret.replace(/^whsec_/, ""), "base64")

export const signPayload = (
  signingSecret: string,
  id: string,
  timestamp: number,
  body: string,
): string => {
  const signature = createHmac("sha256", secretKey(signingSecret))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")
  return `v1,${signature}`
}

export const signatureHeaders = (
  signingSecret: string,
  id: string,
  body: string,
  at: Date = new Date(),
): Record<string, string> => {
  const timestamp = Math.floor(at.getTime() / 1000)
  return {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signPayload(signingSecret, id, timestamp, body),
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signPayload(signingSecret, id, timestamp, body),
  }
}

export const verifySignature = (input: {
  signingSecret: string
  id: string
  timestamp: string
  signature: string
  body: string
  toleranceSeconds?: number
}): boolean => {
  const ts = Number(input.timestamp)
  if (!Number.isFinite(ts)) return false
  const tolerance = input.toleranceSeconds ?? 300
  if (Math.abs(Date.now() / 1000 - ts) > tolerance) return false

  const expected = signPayload(input.signingSecret, input.id, ts, input.body)
  const expectedSig = expected.slice(3)
  // The header may carry several space-separated versioned signatures.
  for (const candidate of input.signature.split(" ")) {
    const [version, sig] = candidate.split(",")
    if (version !== "v1" || !sig) continue
    const a = Buffer.from(sig)
    const b = Buffer.from(expectedSig)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

export { raw }
