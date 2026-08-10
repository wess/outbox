/**
 * Delivers real bounces to the inbound SMTP server and checks what the sending
 * side learns from them.
 *
 * Usage: OUTBOX_API_KEY=ob_... bun run packages/inbound/test/bounce.ts
 */
import { closeDb, db } from "@outbox/core/db"
import { startInbound } from "@outbox/inbound"

const BASE = process.env.OUTBOX_BASE ?? "http://localhost:3000"
const KEY = process.env.OUTBOX_API_KEY
if (!KEY) {
  console.error("set OUTBOX_API_KEY")
  process.exit(1)
}

const CRLF = "\r\n"
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
        "user-agent": "outbox-bounce-test/1.0",
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
    if (res.status === 429 && attempt < 20) {
      await sleep(1100)
      continue
    }
    return { status: res.status, body: parsed }
  }
}

/** Minimal SMTP client — enough to hand one message to the inbound server. */
const deliver = async (port: number, from: string, to: string, raw: string): Promise<string> => {
  const replies: string[] = []
  let buffer = ""
  let resolveLine: ((line: string) => void) | null = null

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        buffer += chunk.toString()
        for (;;) {
          const idx = buffer.indexOf(CRLF)
          if (idx === -1) break
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          replies.push(line)
          if (/^\d{3} /.test(line) && resolveLine) {
            const fn = resolveLine
            resolveLine = null
            fn(line)
          }
        }
      },
      open() {},
      error() {},
      close() {},
    },
  })

  const expect = () =>
    new Promise<string>((resolve) => {
      resolveLine = resolve
    })

  const greeting = expect()
  await greeting
  const say = async (line: string) => {
    const next = expect()
    socket.write(line + CRLF)
    return next
  }

  await say("EHLO test.local")
  await say(`MAIL FROM:<${from}>`)
  const rcpt = await say(`RCPT TO:<${to}>`)
  if (!rcpt.startsWith("250")) {
    socket.end()
    return rcpt
  }
  await say("DATA")
  const done = expect()
  socket.write(raw.replace(/\r?\n/g, CRLF))
  socket.write(`${CRLF}.${CRLF}`)
  const result = await done
  socket.write(`QUIT${CRLF}`)
  socket.end()
  return result
}

const dsnFor = (returnPath: string, recipient: string, status: string, diagnostic: string) =>
  [
    "From: MAILER-DAEMON@mx.example.net",
    `To: ${returnPath}`,
    "Subject: Undelivered Mail Returned to Sender",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain",
    "",
    "Delivery failed.",
    "",
    "--BOUND",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.net",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
    "",
    "--BOUND--",
    "",
  ].join("\n")

// ---------------------------------------------------------------- setup --
section("setup")
const stamp = Date.now()
const domainName = `bounce-${stamp}.test`

const domain = await call("POST", "/domains", { name: domainName })
check("domain created", domain.status === 201, domain.body)

// The transport check is skipped on `console`, so a send works before DNS does.
const recipient = `dead-${stamp}@example.com`
const sent = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: [recipient],
  subject: "Will bounce",
  text: "hello",
})
check("email sent", sent.status === 200, sent.body)
const emailId = sent.body.id

const delivered = await (async () => {
  for (let i = 0; i < 40; i++) {
    const r = await call("GET", `/emails/${emailId}`)
    if (r.body.last_event === "delivered") return r.body
    await sleep(500)
  }
  return null
})()
check("worker delivered it", Boolean(delivered), delivered)

const inbound = await startInbound(0)
console.log(`  inbound listening on ${inbound.port}`)

// --------------------------------------------------------- hard bounce --
section("hard bounce")
const returnPath = `bounces+${emailId}@send.${domainName}`
const hardReply = await deliver(
  inbound.port,
  "MAILER-DAEMON@mx.example.net",
  returnPath,
  dsnFor(returnPath, recipient, "5.1.1", `550 5.1.1 <${recipient}>: User unknown`),
)
check("inbound accepted the bounce", hardReply.startsWith("250"), hardReply)
await sleep(1500)

const afterHard = await call("GET", `/emails/${emailId}`)
check("email is marked bounced", afterHard.body.last_event === "bounced", afterHard.body)

const suppression = await call("GET", `/suppressions/${recipient}`)
check("address was suppressed", suppression.status === 200, suppression.body)
check("suppression origin is bounce", suppression.body.origin === "bounce", suppression.body)
check("suppression points at the email", suppression.body.source_id === emailId, suppression.body)

const bounceType = await db().one<{ bounce_type: string | null }>({
  text: "SELECT bounce_type FROM email_recipients WHERE email_id = $1 AND address = $2",
  values: [emailId, recipient],
})
check("recipient recorded as a hard bounce", bounceType?.bounce_type === "hard", bounceType)

// A suppressed address must not be sent to again.
const blocked = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: [recipient],
  subject: "Should not go",
  text: "no",
})
const blockedState = await (async () => {
  for (let i = 0; i < 30; i++) {
    const r = await call("GET", `/emails/${blocked.body.id}`)
    if (r.body.last_event === "suppressed") return r.body
    await sleep(500)
  }
  return null
})()
check("later sends to that address are suppressed", Boolean(blockedState), blockedState)

// --------------------------------------------------------- soft bounce --
section("soft bounce")
const softRecipient = `full-${stamp}@example.com`
const softSent = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: [softRecipient],
  subject: "Will soft bounce",
  text: "hello",
})
await sleep(2500)

const softReturn = `bounces+${softSent.body.id}@send.${domainName}`
await deliver(
  inbound.port,
  "MAILER-DAEMON@mx.example.net",
  softReturn,
  dsnFor(softReturn, softRecipient, "4.2.2", "452 4.2.2 Mailbox full"),
)
await sleep(1500)

const softSuppression = await call("GET", `/suppressions/${softRecipient}`)
check("a soft bounce does not suppress", softSuppression.status === 404, softSuppression.body)

const softType = await db().one<{ bounce_type: string | null }>({
  text: "SELECT bounce_type FROM email_recipients WHERE email_id = $1 AND address = $2",
  values: [softSent.body.id, softRecipient],
})
check("recipient recorded as a soft bounce", softType?.bounce_type === "soft", softType)

// ----------------------------------------------------------- complaint --
section("complaint")
const complainer = `annoyed-${stamp}@example.com`
const complained = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: [complainer],
  subject: "Will be reported",
  text: "hello",
})
await sleep(2500)

const arfReturn = `bounces+${complained.body.id}@send.${domainName}`
const arf = [
  "From: complaints@isp.example",
  `To: ${arfReturn}`,
  'Content-Type: multipart/report; report-type=feedback-report; boundary="F"',
  "",
  "--F",
  "Content-Type: text/plain",
  "",
  "This is an email abuse report.",
  "",
  "--F",
  "Content-Type: message/feedback-report",
  "",
  "Feedback-Type: abuse",
  "User-Agent: SomeISP/1.0",
  "Version: 1",
  `Original-Rcpt-To: ${complainer}`,
  "",
  "--F--",
  "",
].join("\n")

await deliver(inbound.port, "complaints@isp.example", arfReturn, arf)
await sleep(1500)

const complaintSuppression = await call("GET", `/suppressions/${complainer}`)
check(
  "complaint suppressed the address",
  complaintSuppression.status === 200,
  complaintSuppression.body,
)
check(
  "origin is complaint",
  complaintSuppression.body.origin === "complaint",
  complaintSuppression.body,
)

const complaintEmail = await call("GET", `/emails/${complained.body.id}`)
check(
  "email is marked complained",
  complaintEmail.body.last_event === "complained",
  complaintEmail.body,
)

// ------------------------------------------------------------ routing --
section("routing")
const strangerReply = await deliver(
  inbound.port,
  "someone@elsewhere.test",
  `hello@${domainName}`,
  "Subject: hi\n\nnot a bounce",
)
check(
  "ordinary mail is still refused when receiving is off",
  strangerReply.startsWith("550"),
  strangerReply,
)

inbound.stop()
await call("DELETE", `/domains/${domain.body.id}`)
await closeDb()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
