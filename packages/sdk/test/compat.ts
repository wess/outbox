/**
 * Runs the official `resend` npm package against Outbox with nothing changed
 * but the base URL. This is the compatibility claim in the README, verified.
 */
import { Resend } from "resend"

const key = process.env.OUTBOX_API_KEY!
const resend = new Resend(key)
// The SDK reads baseUrl off the instance; point it at the local server.
;(resend as unknown as { baseUrl: string }).baseUrl = "http://localhost:3000"

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, JSON.stringify(detail)?.slice(0, 300))
  }
}

const stamp = Date.now()

// The server rate-limits to RATE_LIMIT_PER_SECOND per team and the official SDK
// does not back off, so pace the calls rather than race the limiter.
const pace = () => new Promise((r) => setTimeout(r, 250))

await pace()
const domain = await resend.domains.create({ name: `sdk-${stamp}.test` })
check("domains.create", !domain.error && Boolean(domain.data?.id), domain.error ?? domain.data)

await pace()
const sent = await resend.emails.send({
  from: `Acme <hi@sdk-${stamp}.test>`,
  to: [`sdk-${stamp}@example.com`],
  subject: "Sent by the official Resend SDK",
  html: "<strong>It works.</strong>",
  tags: [{ name: "source", value: "sdk_test" }],
})
check("emails.send", !sent.error && Boolean(sent.data?.id), sent.error ?? sent.data)

await pace()
const fetched = await resend.emails.get(sent.data!.id)
check(
  "emails.get returns the same email",
  fetched.data?.id === sent.data!.id,
  fetched.error ?? fetched.data,
)
check(
  "subject round-trips",
  fetched.data?.subject === "Sent by the official Resend SDK",
  fetched.data,
)

await pace()
const listed = await resend.emails.list()
check("emails.list", !listed.error && Array.isArray((listed.data as any)?.data), listed.error)

// camelCase in, snake_case on the wire — the SDK converts, so scheduling proves
// the server reads what the SDK actually sends.
await pace()
const scheduled = await resend.emails.send({
  from: `Acme <hi@sdk-${stamp}.test>`,
  to: [`later-${stamp}@example.com`],
  subject: "Scheduled",
  text: "later",
  scheduledAt: "in 1 hour",
})
check("emails.send with scheduledAt", !scheduled.error, scheduled.error)
await pace()
const scheduledGet = await resend.emails.get(scheduled.data!.id)
check(
  "server honoured scheduledAt",
  scheduledGet.data?.last_event === "scheduled",
  scheduledGet.data,
)

await pace()
const canceled = await resend.emails.cancel(scheduled.data!.id)
check("emails.cancel", !canceled.error, canceled.error)

await pace()
const batch = await resend.batch.send([
  {
    from: `Acme <hi@sdk-${stamp}.test>`,
    to: [`b1-${stamp}@example.com`],
    subject: "b1",
    text: "1",
  },
  {
    from: `Acme <hi@sdk-${stamp}.test>`,
    to: [`b2-${stamp}@example.com`],
    subject: "b2",
    text: "2",
  },
])
check(
  "batch.send",
  !batch.error && (batch.data as any)?.data?.length === 2,
  batch.error ?? batch.data,
)

await pace()
const audience = await resend.audiences.create({ name: `SDK ${stamp}` })
check(
  "audiences.create (legacy alias)",
  !audience.error && Boolean(audience.data?.id),
  audience.error,
)

await pace()
const contact = await resend.contacts.create({
  email: `contact-${stamp}@example.com`,
  firstName: "Ada",
  lastName: "Lovelace",
  audienceId: audience.data!.id,
})
check(
  "contacts.create with camelCase",
  !contact.error && Boolean(contact.data?.id),
  contact.error ?? contact.data,
)

await pace()
const apiKey = await resend.apiKeys.create({ name: `sdk-${stamp}` })
check("apiKeys.create", !apiKey.error && Boolean((apiKey.data as any)?.token), apiKey.error)
await pace()
await resend.apiKeys.remove((apiKey.data as any).id)

// An error must arrive in the SDK's own { data, error } shape.
await pace()
const bad = await resend.emails.send({ from: "nope", to: ["x@y.com"], subject: "s", html: "h" })
check("errors surface as SDK errors", Boolean(bad.error) && bad.data === null, bad)
check("error carries Resend's name field", typeof (bad.error as any)?.name === "string", bad.error)

await pace()
await resend.domains.remove(domain.data!.id)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
