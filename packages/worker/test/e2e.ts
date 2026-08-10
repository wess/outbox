/**
 * Drives the whole pipeline against a running `outbox dev`:
 * send -> worker -> events -> webhook delivery -> tracking -> broadcast -> automation.
 *
 * Usage: OUTBOX_API_KEY=ob_... bun run packages/worker/test/e2e.ts
 */
import { createHmac, timingSafeEqual } from "node:crypto"

const BASE = process.env.OUTBOX_BASE ?? "http://localhost:3000"
const KEY = process.env.OUTBOX_API_KEY
if (!KEY) {
  console.error("set OUTBOX_API_KEY")
  process.exit(1)
}

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400))
  }
}
const section = (n: string) => console.log(`\n${n}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const call = async (method: string, path: string, body?: unknown): Promise<any> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "user-agent": "outbox-e2e/1.0",
        authorization: `Bearer ${KEY}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    if (res.status === 429 && attempt < 30) {
      await sleep(1100)
      continue
    }
    return { status: res.status, body: parsed }
  }
}

const until = async <T>(fn: () => Promise<T | null>, ms = 25_000): Promise<T | null> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(500)
  }
  return null
}

// ------------------------------------------------- local webhook receiver --
type Received = { headers: Record<string, string>; body: string; json: any }
const inbox: Received[] = []
const receiver = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = await req.text()
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k] = v
    })
    let json: any = null
    try {
      json = JSON.parse(body)
    } catch {}
    inbox.push({ headers, body, json })
    return new Response("ok")
  },
})
const hookUrl = `http://localhost:${receiver.port}/hook`

// Verifies exactly the way the Svix libraries do.
const verifySvix = (secret: string, r: Received): boolean => {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const id = r.headers["svix-id"]!
  const ts = r.headers["svix-timestamp"]!
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${r.body}`).digest("base64")
  for (const part of (r.headers["svix-signature"] ?? "").split(" ")) {
    const [version, sig] = part.split(",")
    if (version !== "v1" || !sig) continue
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

// -------------------------------------------------------------- setup --
section("setup")
const stamp = Date.now()
const domainName = `e2e-${stamp}.test`
const domain = await call("POST", "/domains", {
  name: domainName,
  open_tracking: true,
  click_tracking: true,
})
check("domain created", domain.status === 201, domain.body)
const _domainId = domain.body.id

// Tracking rewrites only apply once the domain is verified enough to send.
const hook = await call("POST", "/webhooks", {
  endpoint: hookUrl,
  events: ["email.sent", "email.delivered", "email.opened", "email.clicked", "contact.created"],
})
check("webhook created", hook.status === 201, hook.body)
const secret = hook.body.signing_secret

// ------------------------------------------------------ send + deliver --
section("send pipeline")
const send = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: [`recipient-${stamp}@example.com`],
  subject: "E2E hello",
  html: '<h1>Hi</h1><p><a href="https://example.com/pricing">See pricing</a></p><p>{{{OUTBOX_UNSUBSCRIBE_URL}}}</p>',
  tags: [{ name: "category", value: "e2e" }],
})
check("send accepted", send.status === 200 && send.body.id, send.body)
const emailId = send.body.id

const delivered = await until(async () => {
  const r = await call("GET", `/emails/${emailId}`)
  return r.body.last_event === "delivered" ? r.body : null
})
check("worker delivered the email", Boolean(delivered), delivered)
check("message_id assigned", Boolean(delivered?.message_id), delivered?.message_id)

// --------------------------------------------------- webhook delivery --
section("webhooks")
const sentHook = await until(
  async () =>
    inbox.find((r) => r.json?.type === "email.sent" && r.json?.data?.email_id === emailId) ?? null,
)
check(
  "email.sent webhook received",
  Boolean(sentHook),
  inbox.map((r) => r.json?.type),
)
check("svix signature verifies", sentHook ? verifySvix(secret, sentHook) : false)
check(
  "svix-id is msg_-prefixed",
  String(sentHook?.headers["svix-id"]).startsWith("msg_"),
  sentHook?.headers["svix-id"],
)
check(
  "payload has type/created_at/data",
  Boolean(sentHook?.json?.type && sentHook?.json?.created_at && sentHook?.json?.data),
)
check(
  "tags rendered as an object map",
  sentHook?.json?.data?.tags?.category === "e2e",
  sentHook?.json?.data?.tags,
)
// Each event is its own queued job, so `delivered` can land after `sent`.
const deliveredHook = await until(
  async () =>
    inbox.find((r) => r.json?.type === "email.delivered" && r.json?.data?.email_id === emailId) ??
    null,
)
check(
  "delivered webhook received",
  Boolean(deliveredHook),
  inbox.map((r) => r.json?.type),
)

const wrongSecret = sentHook
  ? verifySvix(`whsec_${Buffer.from("nope").toString("base64")}`, sentHook)
  : true
check("signature rejects a wrong secret", wrongSecret === false)

const events = await call("GET", `/webhooks/${hook.body.id}/events`)
check("events listed", events.body.data.length > 0, events.body)

// The attempt row is written after the POST returns, so poll for it.
const attempts = await until(async () => {
  const res = await call(
    "GET",
    `/webhooks/${hook.body.id}/events/${events.body.data[0].id}/attempts`,
  )
  return res.body.data?.length ? res.body : null
})
check("attempts recorded with status code", attempts?.data?.[0]?.http_status_code === 200, attempts)

// -------------------------------------------------------- suppression --
section("suppression blocks delivery")
const blockedAddress = `blocked-${stamp}@example.com`
await call("POST", "/suppressions", { email: blockedAddress })
const blocked = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: blockedAddress,
  subject: "Should not send",
  text: "nope",
})
const suppressed = await until(async () => {
  const r = await call("GET", `/emails/${blocked.body.id}`)
  return r.body.last_event === "suppressed" ? r.body : null
})
check("suppressed address is not delivered", Boolean(suppressed), suppressed)

// ------------------------------------------------------------ topics --
section("topic opt-out blocks delivery")
const topic = await call("POST", "/topics", {
  name: `E2E ${stamp}`,
  default_subscription: "opt_out",
})
const optOut = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: `stranger-${stamp}@example.com`,
  subject: "Topic gated",
  text: "hi",
  topic_id: topic.body.id,
})
const gated = await until(async () => {
  const r = await call("GET", `/emails/${optOut.body.id}`)
  return r.body.last_event === "failed" ? r.body : null
})
check("opt_out default blocks non-contacts", Boolean(gated), gated)

// --------------------------------------------------------- broadcast --
section("broadcast fan-out")
const segment = await call("POST", "/segments", { name: `E2E ${stamp}` })
for (const n of [1, 2, 3]) {
  await call("POST", "/contacts", {
    email: `member${n}-${stamp}@example.com`,
    first_name: `Member${n}`,
    segments: [{ id: segment.body.id }],
  })
}
// One unsubscribed contact must be skipped.
const unsub = await call("POST", "/contacts", {
  email: `unsub-${stamp}@example.com`,
  unsubscribed: true,
  segments: [{ id: segment.body.id }],
})
check("contacts created", unsub.status === 201, unsub.body)

const broadcast = await call("POST", "/broadcasts", {
  segment_id: segment.body.id,
  from: `Acme <news@${domainName}>`,
  subject: "Hello {{{contact.first_name|there}}}",
  html: "<p>Hi {{{contact.first_name|there}}}, welcome.</p>",
  send: true,
})
check("broadcast queued", broadcast.status === 201, broadcast.body)

const finished = await until(async () => {
  const r = await call("GET", `/broadcasts/${broadcast.body.id}`)
  return r.body.status === "sent" ? r.body : null
})
check("broadcast reached sent", Boolean(finished), finished)

const bMetrics = await call("GET", `/broadcasts/${broadcast.body.id}/metrics`)
check(
  "3 recipients queued, 1 skipped",
  bMetrics.body.total === 4 && bMetrics.body.sent === 3,
  bMetrics.body,
)

const broadcastEmails = await call("GET", "/emails?limit=100")
const personalised = broadcastEmails.body.data.find((e: any) => e.subject === "Hello Member1")
check(
  "subject personalised per contact",
  Boolean(personalised),
  broadcastEmails.body.data.slice(0, 3),
)

// -------------------------------------------------------- automation --
section("automation run")
const automation = await call("POST", "/automations", {
  name: `E2E ${stamp}`,
  status: "enabled",
  steps: [
    { key: "start", type: "trigger", config: { event_name: `e2e.signup.${stamp}` } },
    {
      key: "check",
      type: "condition",
      config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" },
    },
    {
      key: "pro_mail",
      type: "send_email",
      config: { from: `Acme <hi@${domainName}>`, subject: "Pro welcome", html: "<p>Pro</p>" },
    },
    {
      key: "free_mail",
      type: "send_email",
      config: { from: `Acme <hi@${domainName}>`, subject: "Free welcome", html: "<p>Free</p>" },
    },
  ],
  edges: [
    { from: "start", to: "check", type: "default" },
    { from: "check", to: "pro_mail", type: "condition_met" },
    { from: "check", to: "free_mail", type: "condition_not_met" },
  ],
})
check("automation created", automation.status === 201, automation.body)

const proEmail = `pro-${stamp}@example.com`
await call("POST", "/events/send", {
  name: `e2e.signup.${stamp}`,
  email: proEmail,
  data: { plan: "pro" },
})
const proRun = await until(async () => {
  const r = await call("GET", `/automations/${automation.body.id}/runs`)
  const run = r.body.data.find((x: any) => x.email === proEmail)
  return run?.status === "completed" ? run : null
})
check("pro run completed", Boolean(proRun), proRun)

const proDetail = proRun
  ? await call("GET", `/automations/${automation.body.id}/runs/${proRun.id}`)
  : null
check(
  "condition_met branch taken",
  proDetail?.body.steps.some((s: any) => s.key === "pro_mail" && s.status === "completed") &&
    !proDetail?.body.steps.some((s: any) => s.key === "free_mail"),
  proDetail?.body.steps,
)

const freeEmail = `free-${stamp}@example.com`
await call("POST", "/events/send", {
  name: `e2e.signup.${stamp}`,
  email: freeEmail,
  data: { plan: "free" },
})
const freeRun = await until(async () => {
  const r = await call("GET", `/automations/${automation.body.id}/runs`)
  const run = r.body.data.find((x: any) => x.email === freeEmail)
  return run?.status === "completed" ? run : null
})
const freeDetail = freeRun
  ? await call("GET", `/automations/${automation.body.id}/runs/${freeRun.id}`)
  : null
check(
  "condition_not_met branch taken",
  freeDetail?.body.steps.some((s: any) => s.key === "free_mail" && s.status === "completed") &&
    !freeDetail?.body.steps.some((s: any) => s.key === "pro_mail"),
  freeDetail?.body.steps,
)

// ---------------------------------------------------------- metrics --
section("metrics reflect the run")
const metrics = await call("GET", "/emails/metrics?metrics=sent,delivered,delivery_rate")
const totals = metrics.body.data?.[0]
check("sent counted", (totals?.sent ?? 0) > 0, metrics.body)
check("delivery_rate computed", typeof totals?.delivery_rate === "number", totals)

receiver.stop(true)
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
