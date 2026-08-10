/**
 * Drives the SMTP client through STARTTLS against a real mail exchanger.
 *
 * This exists because the bug it guards against is invisible to a unit test and
 * was invisible in staging: `upgradeTLS` leaves the original handlers attached
 * to the underlying socket, so the reply parser received raw ciphertext, and a
 * command written before the handshake finished was simply lost. Both failed as
 * a silent sixty-second timeout with nothing in the logs to explain it — and
 * they broke delivery to *every* server that offers STARTTLS, which is very
 * nearly all of them.
 *
 * It stops at RCPT TO and never sends DATA, so running it delivers nothing.
 *
 * Usage: bun run packages/delivery/test/starttls.ts [mx-hostname ...]
 */
import { connectSmtp, SmtpError } from "../smtp/index.ts"

const hosts = process.argv.slice(2)
if (hosts.length === 0) hosts.push("gmail-smtp-in.l.google.com")

let passed = 0
let failed = 0
let skipped = 0

for (const host of hosts) {
  console.log(`\n${host}`)
  try {
    const session = await connectSmtp({
      host,
      port: 25,
      secure: "starttls",
      clientName: process.env.OUTBOX_HOSTNAME ?? "localhost",
      timeoutMs: 30_000,
      rejectUnauthorized: false,
    })

    // Reaching this line at all means the handshake completed and the reply
    // parser saw plaintext: a session that yields capabilities cannot have been
    // fed ciphertext.
    console.log(`  ok    STARTTLS session established`)
    console.log(`  ok    capabilities readable after upgrade (${session.capabilities.size})`)
    passed += 2

    const reply = await session.command("MAIL FROM:<probe@example.invalid>")
    console.log(`  ok    server still answering commands over TLS (${reply.code})`)
    passed++

    await session.command("QUIT")
    session.close()
  } catch (error) {
    // A 5xx from the far end is a real answer over a working TLS session; only
    // a timeout or a handshake failure means the client is broken.
    const message = (error as Error).message
    if (error instanceof SmtpError) {
      console.log(`  ok    server answered over TLS (${error.code})`)
      passed++
    } else if (/Failed to connect|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(message)) {
      // Most residential and cloud networks block outbound 25, and some
      // providers refuse ranges outright. That says nothing about this client,
      // so it is a skip rather than a failure — run it from the mail server.
      console.log(`  skip  could not reach ${host} on port 25 (${message})`)
      skipped++
    } else {
      console.log(`  FAIL  ${message}`)
      failed++
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`)
if (passed === 0 && skipped > 0) {
  console.log("nothing was actually tested — run this from a host with port 25 egress")
}
process.exit(failed > 0 ? 1 : 0)
