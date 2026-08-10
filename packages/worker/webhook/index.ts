import { signatureHeaders } from "@outbox/core"
import { db } from "@outbox/core/db"
import {
  type Webhook,
  type WebhookEvent,
  webhookAttempts,
  webhookEvents,
  webhooks,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"

const MAX_ATTEMPTS = 8
const TIMEOUT_MS = 10_000

// Svix-style schedule: quick retries first, then hourly, spread over ~a day.
const BACKOFF_SECONDS = [5, 30, 300, 1800, 7200, 18000, 36000, 86400]

export type DeliveryResult = { status: "delivered" | "retrying" | "exhausted"; detail: string }

export const deliverWebhookEvent = async (eventId: string): Promise<DeliveryResult> => {
  const conn = db()
  const event = await conn.one<WebhookEvent>(
    from(webhookEvents).where((q) => q("id").equals(eventId)),
  )
  if (!event) return { status: "delivered", detail: "event no longer exists" }
  if (event.status === "delivered") return { status: "delivered", detail: "already delivered" }

  const hook = await conn.one<Webhook>(
    from(webhooks).where((q) => q("id").equals(event.webhook_id)),
  )
  if (!hook) return { status: "delivered", detail: "webhook removed" }
  if (hook.status !== "enabled") {
    await conn.execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({ status: "failed" }),
    )
    return { status: "exhausted", detail: "webhook disabled" }
  }

  const body = JSON.stringify(event.payload)
  const headers = {
    "content-type": "application/json",
    "user-agent": "Outbox-Webhook/1.0",
    ...signatureHeaders(hook.signing_secret, event.id, body),
  }

  const started = performance.now()
  let statusCode: number | null = null
  let responseText: string | null = null
  let error: string | null = null

  try {
    const res = await fetch(hook.endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    statusCode = res.status
    responseText = (await res.text()).slice(0, 2000)
  } catch (e) {
    error = (e as Error).message
  }

  const attempts = event.attempts + 1
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300

  await conn.execute(
    from(webhookAttempts).insert({
      webhook_event_id: event.id,
      webhook_id: hook.id,
      http_status_code: statusCode,
      response: responseText,
      error,
      duration_ms: Math.round(performance.now() - started),
    }),
  )

  if (ok) {
    await conn.execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({
          status: "delivered",
          attempts,
          delivered_at: new Date(),
          next_attempt_at: null,
        }),
    )
    return { status: "delivered", detail: `HTTP ${statusCode}` }
  }

  const detail = error ?? `HTTP ${statusCode}`
  if (attempts >= MAX_ATTEMPTS) {
    await conn.execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({ status: "exhausted", attempts, next_attempt_at: null }),
    )
    return { status: "exhausted", detail }
  }

  const delay = BACKOFF_SECONDS[attempts - 1] ?? 86400
  const nextAttempt = new Date(Date.now() + delay * 1000)
  await conn.execute(
    from(webhookEvents)
      .where((q) => q("id").equals(event.id))
      .update({ status: "pending", attempts, next_attempt_at: nextAttempt }),
  )
  // Signal the runner to reschedule rather than mark the job done.
  return { status: "retrying", detail: `${detail}; next attempt at ${nextAttempt.toISOString()}` }
}

/** Re-queues an event for immediate delivery, for the dashboard's replay button. */
export const replayWebhookEvent = async (eventId: string): Promise<void> => {
  await db().execute(
    from(webhookEvents)
      .where((q) => q("id").equals(eventId))
      .update({ status: "pending", attempts: 0, next_attempt_at: new Date() }),
  )
}
