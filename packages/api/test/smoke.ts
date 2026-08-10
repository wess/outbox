/**
 * End-to-end walk through every resource against a running API.
 * Usage: OUTBOX_API_KEY=ob_... bun run packages/api/test/smoke.ts
 */
const BASE = process.env.OUTBOX_BASE ?? "http://localhost:3000"
const KEY = process.env.OUTBOX_API_KEY

if (!KEY) {
  console.error("set OUTBOX_API_KEY")
  process.exit(1)
}

let passed = 0
let failed = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The API caps callers at RATE_LIMIT_PER_SECOND. A real client backs off on 429,
// so the smoke runner does too rather than counting throttles as failures.
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "user-agent": "outbox-smoke/1.0",
        authorization: `Bearer ${KEY}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    if (res.status === 429 && attempt < 20) {
      await sleep(1100)
      continue
    }
    return { status: res.status, body: parsed }
  }
}

const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300))
  }
}

const section = (name: string) => console.log(`\n${name}`)

// ------------------------------------------------------------------ domains --
section("domains")
const domain = await call("POST", "/domains", {
  name: `smoke-${Date.now()}.test`,
  click_tracking: true,
})
check(
  "create returns 201 with records",
  domain.status === 201 && Array.isArray(domain.body.records),
  domain.body,
)
check(
  "emits SPF, DKIM, DMARC records",
  ["SPF", "DKIM", "DMARC"].every((r) => domain.body.records.some((x: any) => x.record === r)),
  domain.body.records?.map((r: any) => r.record),
)
check(
  "capabilities present",
  domain.body.capabilities?.sending === "enabled",
  domain.body.capabilities,
)
const domainId = domain.body.id

const domainGet = await call("GET", `/domains/${domainId}`)
check("retrieve", domainGet.status === 200 && domainGet.body.id === domainId, domainGet.body)
const domainList = await call("GET", "/domains")
check(
  "list envelope",
  domainList.body.object === "list" && Array.isArray(domainList.body.data),
  domainList.body,
)
const domainPatch = await call("PATCH", `/domains/${domainId}`, { open_tracking: true })
check("update", domainPatch.status === 200, domainPatch.body)
const domainVerify = await call("POST", `/domains/${domainId}/verify`)
check(
  "verify runs and reports status",
  domainVerify.status === 200 && typeof domainVerify.body.status === "string",
  domainVerify.body,
)

// -------------------------------------------------------------- api keys --
section("api-keys")
const key = await call("POST", "/api-keys", { name: "smoke", permission: "sending_access" })
check(
  "create returns token once",
  key.status === 201 && typeof key.body.token === "string",
  key.body,
)
const keyList = await call("GET", "/api-keys")
check(
  "list omits token",
  keyList.body.data.every((k: any) => !("token" in k)),
  keyList.body.data?.[0],
)

// sending_access must be rejected on non-send endpoints
const restricted = await fetch(`${BASE}/domains`, {
  headers: { "user-agent": "smoke/1.0", authorization: `Bearer ${key.body.token}` },
})
check(
  "sending_access key blocked from /domains",
  restricted.status === 401,
  await restricted.text(),
)
await call("DELETE", `/api-keys/${key.body.id}`)

// --------------------------------------------------------- contact props --
section("contact-properties")
const propKey = `company_${Date.now()}`
const prop = await call("POST", "/contact-properties", {
  key: propKey,
  type: "string",
  fallback_value: "Acme Corp",
})
check("create", prop.status === 201, prop.body)
const propList = await call("GET", "/contact-properties")
check("list", propList.body.data.length >= 1, propList.body)

// ----------------------------------------------------------------- topics --
section("topics")
const topic = await call("POST", "/topics", {
  name: "Weekly Newsletter",
  default_subscription: "opt_in",
  description: "Weekly digest",
})
check("create", topic.status === 201, topic.body)
const topicId = topic.body.id
const topicGet = await call("GET", `/topics/${topicId}`)
check(
  "retrieve shape",
  topicGet.body.object === "topic" && topicGet.body.default_subscription === "opt_in",
  topicGet.body,
)
check("list always paginates", (await call("GET", "/topics")).body.object === "list")
await call("PATCH", `/topics/${topicId}`, { description: "Updated" })
check("update", (await call("GET", `/topics/${topicId}`)).body.description === "Updated")

// --------------------------------------------------------------- segments --
section("segments")
const segment = await call("POST", "/segments", { name: "Registered Users" })
check("create", segment.status === 201, segment.body)
const segmentId = segment.body.id
check("audiences alias still works", (await call("GET", "/audiences")).status === 200)

// --------------------------------------------------------------- contacts --
section("contacts")
const contact = await call("POST", "/contacts", {
  email: `steve+${Date.now()}@example.com`,
  first_name: "Steve",
  last_name: "Wozniak",
  properties: { [propKey]: "Apple" },
  segments: [{ id: segmentId }],
  topics: [{ id: topicId, subscription: "opt_in" }],
})
check("create with properties, segments, topics", contact.status === 201, contact.body)
const contactId = contact.body.id
const contactGet = await call("GET", `/contacts/${contactId}`)
check("properties resolve", contactGet.body.properties?.[propKey] === "Apple", contactGet.body)
check(
  "addressable by email",
  (await call("GET", `/contacts/${contactGet.body.email}`)).body.id === contactId,
)
check(
  "segments listed",
  (await call("GET", `/contacts/${contactId}/segments`)).body.data.length === 1,
)
check(
  "topics listed with subscription",
  (await call("GET", `/contacts/${contactId}/topics`)).body.data.some(
    (t: any) => t.subscription === "opt_in",
  ),
)
check(
  "segment contacts",
  (await call("GET", `/segments/${segmentId}/contacts`)).body.data.length === 1,
)
check(
  "filter contacts by segment",
  (await call("GET", `/contacts?segment_id=${segmentId}`)).body.data.length === 1,
)
await call("PATCH", `/contacts/${contactId}`, { first_name: "Stephen" })
check("update", (await call("GET", `/contacts/${contactId}`)).body.first_name === "Stephen")
const unknownProp = await call("PATCH", `/contacts/${contactId}`, { properties: { nope: "x" } })
check("unknown property rejected", unknownProp.status === 400, unknownProp.body)

// -------------------------------------------------------------- templates --
section("templates")
const template = await call("POST", "/templates", {
  name: "order-confirmation",
  alias: `order-${Date.now()}`,
  subject: "Your order of {{{PRODUCT}}}",
  from: "Acme <orders@acme.test>",
  html: "<p>Name: {{{PRODUCT}}}</p><p>Total: {{{PRICE}}}</p>",
  variables: [
    { key: "PRODUCT", type: "string", fallback_value: "item" },
    { key: "PRICE", type: "number", fallback_value: 25 },
  ],
})
check("create", template.status === 201, template.body)
const templateId = template.body.id
const templateGet = await call("GET", `/templates/${templateId}`)
check(
  "draft has unpublished versions",
  templateGet.body.has_unpublished_versions === true,
  templateGet.body,
)
check(
  "variables serialised with types",
  templateGet.body.variables?.length === 2,
  templateGet.body.variables,
)
const publish = await call("POST", `/templates/${templateId}/publish`)
check("publish", publish.status === 200, publish.body)
const published = await call("GET", `/templates/${templateId}`)
check(
  "status published, no unpublished",
  published.body.status === "published" && published.body.has_unpublished_versions === false,
  published.body,
)
const dup = await call("POST", `/templates/${templateId}/duplicate`)
check("duplicate", dup.status === 201, dup.body)

// send using the template + variables
const templated = await call("POST", "/emails", {
  from: "Acme <orders@acme.test>",
  to: "buyer@example.com",
  template: { id: templateId, variables: { PRODUCT: "Widget", PRICE: 42 } },
})
check("send with template", templated.status === 200, templated.body)
const templatedGet = await call("GET", `/emails/${templated.body.id}`)
check(
  "template variables rendered",
  templatedGet.body.html?.includes("Widget") && templatedGet.body.html?.includes("42"),
  templatedGet.body.html,
)
check(
  "template subject rendered",
  templatedGet.body.subject === "Your order of Widget",
  templatedGet.body.subject,
)

// ------------------------------------------------------------ suppressions --
section("suppressions")
const supp = await call("POST", "/suppressions", { email: "bounced@example.com" })
check("add", supp.status === 201, supp.body)
check(
  "retrieve by email",
  (await call("GET", "/suppressions/bounced@example.com")).body.email === "bounced@example.com",
)
const batch = await call("POST", "/suppressions/batch/add", { emails: ["a@x.test", "b@x.test"] })
check("batch add", batch.status === 201 && batch.body.data.length === 2, batch.body)
const batchRemove = await call("POST", "/suppressions/batch/remove", {
  emails: ["a@x.test", "b@x.test"],
})
check("batch remove", batchRemove.body.data.length === 2, batchRemove.body)
check("filter by origin", (await call("GET", "/suppressions?origin=manual")).body.data.length >= 1)
await call("DELETE", "/suppressions/bounced@example.com")
check("removed", (await call("GET", "/suppressions/bounced@example.com")).status === 404)

// -------------------------------------------------------------- broadcasts --
section("broadcasts")
const broadcast = await call("POST", "/broadcasts", {
  segment_id: segmentId,
  from: "Acme <news@acme.test>",
  subject: "Announcements",
  html: "<p>Hello {{{contact.first_name|there}}}!</p>",
  preview_text: "Latest news",
})
check("create draft", broadcast.status === 201, broadcast.body)
const broadcastId = broadcast.body.id
const broadcastGet = await call("GET", `/broadcasts/${broadcastId}`)
check(
  "audience_id alias present",
  broadcastGet.body.audience_id === segmentId && broadcastGet.body.segment_id === segmentId,
  broadcastGet.body,
)
check("status draft", broadcastGet.body.status === "draft")
await call("PATCH", `/broadcasts/${broadcastId}`, { subject: "Updated subject" })
check(
  "update",
  (await call("GET", `/broadcasts/${broadcastId}`)).body.subject === "Updated subject",
)
const metrics = await call("GET", `/broadcasts/${broadcastId}/metrics`)
check(
  "metrics shape",
  metrics.status === 200 && typeof metrics.body.total === "number",
  metrics.body,
)

// ---------------------------------------------------------------- webhooks --
section("webhooks")
const webhook = await call("POST", "/webhooks", {
  endpoint: "https://example.com/hook",
  events: ["email.sent", "email.delivered", "contact.created"],
})
check(
  "create returns signing secret",
  webhook.status === 201 && String(webhook.body.signing_secret).startsWith("whsec_"),
  webhook.body,
)
const webhookId = webhook.body.id
check(
  "bad event type rejected",
  (await call("POST", "/webhooks", { endpoint: "https://x.test/h", events: ["nope.bad"] }))
    .status === 422,
)
await call("PATCH", `/webhooks/${webhookId}`, { status: "disabled" })
check("update status", (await call("GET", `/webhooks/${webhookId}`)).body.status === "disabled")
check("events list", (await call("GET", `/webhooks/${webhookId}/events`)).body.object === "list")

// ------------------------------------------------------------- automations --
section("automations")
const automation = await call("POST", "/automations", {
  name: "Welcome series",
  status: "enabled",
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    {
      key: "check_plan",
      type: "condition",
      config: { type: "rule", field: "event.plan", operator: "eq", value: "pro" },
    },
    { key: "wait", type: "delay", config: { seconds: 1 } },
    { key: "send_pro", type: "send_email", config: { template_id: templateId } },
    {
      key: "send_free",
      type: "send_email",
      config: { subject: "Welcome", html: "<p>hi</p>", from: "Acme <hi@acme.test>" },
    },
  ],
  edges: [
    { from: "start", to: "check_plan", type: "default" },
    { from: "check_plan", to: "wait", type: "condition_met" },
    { from: "wait", to: "send_pro", type: "default" },
    { from: "check_plan", to: "send_free", type: "condition_not_met" },
  ],
})
check(
  "create graph",
  automation.status === 201 && automation.body.steps.length === 5,
  automation.body,
)
const automationId = automation.body.id
check("edges persisted", automation.body.edges.length === 4, automation.body.edges)
const noTrigger = await call("POST", "/automations", {
  name: "bad",
  steps: [{ key: "a", type: "delay" }],
})
check("rejects graph with no trigger", noTrigger.status === 400, noTrigger.body)
const danglingEdge = await call("POST", "/automations", {
  name: "bad2",
  steps: [{ key: "start", type: "trigger", config: { event_name: "x" } }],
  edges: [{ from: "start", to: "ghost" }],
})
check("rejects dangling edge", danglingEdge.status === 400, danglingEdge.body)

const event = await call("POST", "/events/send", {
  name: "user.created",
  email: contactGet.body.email,
  data: { plan: "pro" },
})
check("send event", event.status === 200, event.body)
check(
  "custom events registered",
  (await call("GET", "/automations/events")).body.data.some((e: any) => e.name === "user.created"),
)

// -------------------------------------------------------------- pagination --
section("pagination")
// Seed enough rows that paging is meaningful on an empty database too, rather
// than depending on what earlier sections happened to leave behind.
for (const n of [1, 2, 3]) {
  await call("POST", "/emails", {
    from: "Acme <paging@acme.test>",
    to: `page${n}-${Date.now()}@example.com`,
    subject: `Paging ${n}`,
    text: String(n),
  })
}

const page1 = await call("GET", "/emails?limit=1")
check("limit respected", page1.body.data.length === 1, page1.body)
check("has_more true", page1.body.has_more === true, page1.body)

const firstId = page1.body.data[0]?.id
const page2 = await call("GET", `/emails?limit=1&after=${firstId}`)
check("cursor excludes itself", page2.body.data[0]?.id !== firstId, page2.body)
check("after returns a row", page2.body.data.length === 1, page2.body)

const back = await call("GET", `/emails?limit=1&before=${page2.body.data[0]?.id}`)
check("before walks back", back.body.data[0]?.id === firstId, back.body)
check("after+before rejected", (await call("GET", "/emails?after=x&before=y")).status === 400)
check("limit over max rejected", (await call("GET", "/emails?limit=500")).status === 400)
check(
  "unknown cursor rejected",
  (await call("GET", "/emails?after=00000000-0000-0000-0000-000000000000")).status === 400,
)

// ------------------------------------------------------------ ownership --
section("instance ownership")
// Any instance reached by this suite already has an account, so a fresh signup
// must not be able to claim ownership.
const late = await fetch(`${BASE}/auth/signup`, {
  method: "POST",
  headers: { "user-agent": "outbox-smoke/1.0", "content-type": "application/json" },
  body: JSON.stringify({
    email: `late-${Date.now()}@example.com`,
    password: "password12345",
    team_name: "Latecomer",
  }),
})
const lateBody = (await late.json()) as { is_owner?: boolean; id?: string }
check("a later signup still succeeds", late.status === 201, lateBody)
check("a later signup is not the instance owner", lateBody.is_owner === false, lateBody)

// ------------------------------------------------------------------- logs --
section("logs")
const logs = await call("GET", "/logs?limit=5")
check("list", logs.status === 200 && logs.body.data.length > 0, logs.body)
const log = await call("GET", `/logs/${logs.body.data[0].id}`)
check("retrieve includes bodies", log.status === 200 && "request_body" in log.body, log.body)

// ---------------------------------------------------------------- metrics --
section("metrics")
const emailMetrics = await call(
  "GET",
  "/emails/metrics?dimensions=period&granularity=daily&metrics=sent,delivered,open_rate",
)
check(
  "email metrics",
  emailMetrics.status === 200 && Array.isArray(emailMetrics.body.data),
  emailMetrics.body,
)
check(
  "bad granularity rejected",
  (await call("GET", "/emails/metrics?granularity=yearly")).status === 400,
)
const segMetrics = await call("GET", "/segments/metrics")
check(
  "segment metrics",
  segMetrics.status === 200 && Array.isArray(segMetrics.body.data),
  segMetrics.body,
)

// ------------------------------------------------------------------ email --
section("scheduling")
const scheduled = await call("POST", "/emails", {
  from: "Acme <onboarding@acme.test>",
  to: "later@example.com",
  subject: "Later",
  text: "hi",
  scheduled_at: "in 1 hour",
})
check("natural language schedule", scheduled.status === 200, scheduled.body)
const scheduledGet = await call("GET", `/emails/${scheduled.body.id}`)
check("last_event scheduled", scheduledGet.body.last_event === "scheduled", scheduledGet.body)
check("scheduled_at set", Boolean(scheduledGet.body.scheduled_at), scheduledGet.body)
const rescheduled = await call("PATCH", `/emails/${scheduled.body.id}`, {
  scheduled_at: "in 2 hours",
})
check("reschedule", rescheduled.status === 200, rescheduled.body)
const canceled = await call("POST", `/emails/${scheduled.body.id}/cancel`)
check("cancel", canceled.status === 200, canceled.body)
check(
  "cancel twice rejected",
  (await call("POST", `/emails/${scheduled.body.id}/cancel`)).status === 400,
)

section("batch")
const batchSend = await call("POST", "/emails/batch", [
  { from: "Acme <a@acme.test>", to: "one@example.com", subject: "1", text: "one" },
  { from: "Acme <a@acme.test>", to: "two@example.com", subject: "2", text: "two" },
])
check("batch send", batchSend.status === 200 && batchSend.body.data.length === 2, batchSend.body)
check(
  "batch over 100 rejected",
  (
    await call(
      "POST",
      "/emails/batch",
      Array.from({ length: 101 }, () => ({
        from: "a@acme.test",
        to: "b@x.test",
        subject: "s",
        text: "t",
      })),
    )
  ).status === 422,
)

section("attachments")
const withAttachment = await call("POST", "/emails", {
  from: "Acme <a@acme.test>",
  to: "att@example.com",
  subject: "With attachment",
  text: "see attached",
  attachments: [{ filename: "note.txt", content: Buffer.from("hello").toString("base64") }],
})
check("send with attachment", withAttachment.status === 200, withAttachment.body)
const attachments = await call("GET", `/emails/${withAttachment.body.id}/attachments`)
check("list attachments", attachments.body.data?.length === 1, attachments.body)
check(
  "retrieve attachment content",
  (
    await call(
      "GET",
      `/emails/${withAttachment.body.id}/attachments/${attachments.body.data[0].id}`,
    )
  ).body.content === Buffer.from("hello").toString("base64"),
)
const blocked = await call("POST", "/emails", {
  from: "Acme <a@acme.test>",
  to: "att@example.com",
  subject: "bad",
  text: "x",
  attachments: [{ filename: "virus.exe", content: "AAAA" }],
})
check("blocked extension rejected", blocked.status === 422, blocked.body)

// ----------------------------------------------------------------- cleanup --
section("delete")
check("delete contact", (await call("DELETE", `/contacts/${contactId}`)).status === 200)
check("delete segment", (await call("DELETE", `/segments/${segmentId}`)).status === 200)
check("delete topic", (await call("DELETE", `/topics/${topicId}`)).status === 200)
check("delete template", (await call("DELETE", `/templates/${templateId}`)).status === 200)
check("delete broadcast", (await call("DELETE", `/broadcasts/${broadcastId}`)).status === 200)
check("delete webhook", (await call("DELETE", `/webhooks/${webhookId}`)).status === 200)
check("delete automation", (await call("DELETE", `/automations/${automationId}`)).status === 200)
check("delete domain", (await call("DELETE", `/domains/${domainId}`)).status === 200)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
