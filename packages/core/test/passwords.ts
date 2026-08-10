/**
 * Password reset, end to end against a running instance.
 *
 * Needs the database, so it lives here rather than in `bun test`. The
 * properties it pins are the ones that matter if this is wrong: that the
 * endpoint cannot be used to discover which addresses have accounts, that a
 * token works exactly once, and that resetting kicks out anyone already signed
 * in with the old password.
 *
 * Usage: bun run packages/core/test/passwords.ts
 */

import { hashToken } from "../auth/index.ts"
import { closeDb, db } from "../db/index.ts"
import { consumePasswordReset, requestPasswordReset } from "../passwords/index.ts"

const BASE = process.env.OUTBOX_BASE ?? "http://localhost:3000"

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300))
  }
}

const call = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "outbox-password-test/1.0" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers }
}

const stamp = Date.now()
const email = `reset-${stamp}@example.com`
const password = "originalPassword1"

console.log("\nsetup")
const signup = await call("/auth/signup", { email, password, team_name: `Reset ${stamp}` })
check("account created", signup.status === 201, signup.body)

console.log("\nno account enumeration")
const known = await call("/auth/forgot-password", { email })
const unknown = await call("/auth/forgot-password", { email: `nobody-${stamp}@example.com` })
check("a known address returns 202", known.status === 202, known.body)
check("an unknown address returns 202 too", unknown.status === 202, unknown.body)
check(
  "both answers are byte-identical",
  JSON.stringify(known.body) === JSON.stringify(unknown.body),
  { known: known.body, unknown: unknown.body },
)

console.log("\ntoken handling")
// Read the token's hash straight from the database: the plaintext is only ever
// in the email, which is the point.
const row = await db().one<{ token_hash: string; used_at: Date | null }>({
  text: `SELECT pr.token_hash, pr.used_at FROM password_resets pr
         JOIN users u ON u.id = pr.user_id
         WHERE u.email = $1 ORDER BY pr.created_at DESC LIMIT 1`,
  values: [email],
})
check("a token row was created", Boolean(row), row)
check(
  "the stored value is a hash, not the token",
  Boolean(row && row.token_hash.length === 64 && /^[0-9a-f]+$/.test(row.token_hash)),
  row?.token_hash,
)

// The only place the plaintext token exists is the email — which is the point,
// and which makes reading it back out of the queued message the honest way to
// test the flow. It also checks the link is actually usable, which hand-minting
// a token would not.
const message = await db().one<{ text: string; subject: string }>({
  text: `SELECT text, subject FROM emails
         WHERE to_addresses::jsonb ? $1 ORDER BY created_at DESC LIMIT 1`,
  values: [email],
})
check("a reset email was queued", Boolean(message), message?.subject)
check("it says what it is", message?.subject.toLowerCase().includes("reset") === true, message?.subject)

const link = message?.text.match(/https?:\/\/\S+token=(\S+)/)
check("the email carries a reset link", Boolean(link), message?.text?.slice(0, 200))
const token = decodeURIComponent(link?.[1] ?? "")
check(
  "the emailed token matches the stored hash",
  Boolean(token) && hashToken(token) === row?.token_hash,
)

console.log("\nsessions before the reset")
const login = await call("/auth/login", { email, password })
check("can sign in with the old password", login.status === 200, login.body)
const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? ""

const meBefore = await fetch(`${BASE}/auth/me`, {
  headers: { cookie, "user-agent": "outbox-password-test/1.0" },
})
check("that session works", meBefore.status === 200)

console.log("\nresetting")
const newPassword = "aBrandNewPassword2"
const reset = await call("/auth/reset-password", { token, password: newPassword })
check("reset succeeds", reset.status === 200, reset.body)

const replay = await call("/auth/reset-password", { token, password: "thirdPassword3" })
check("the same token cannot be used twice", replay.status === 400, replay.body)

const bogus = await call("/auth/reset-password", {
  token: "not-a-real-token",
  password: newPassword,
})
check("an invented token is refused", bogus.status === 400, bogus.body)
check(
  "a spent token and an invented one give the same message",
  replay.body?.message === bogus.body?.message,
  { replay: replay.body?.message, bogus: bogus.body?.message },
)

console.log("\nafter the reset")
const oldLogin = await call("/auth/login", { email, password })
check("the old password no longer works", oldLogin.status === 400, oldLogin.body)

const newLogin = await call("/auth/login", { email, password: newPassword })
check("the new password works", newLogin.status === 200, newLogin.body)

const meAfter = await fetch(`${BASE}/auth/me`, {
  headers: { cookie, "user-agent": "outbox-password-test/1.0" },
})
check("sessions from before the reset were revoked", meAfter.status === 401, meAfter.status)

console.log("\nshort passwords")
// Rejected by the request schema before the handler runs, hence 422 rather than
// the 400 the module itself would raise. Both paths exist deliberately: the
// schema is the fast boundary check, and consumePasswordReset re-checks because
// it is exported and callable directly.
const short = await call("/auth/reset-password", { token, password: "short" })
check("a password under 8 characters is rejected", short.status === 422, short.body)

let shortThrew = false
try {
  await consumePasswordReset("whatever", "short")
} catch {
  shortThrew = true
}
check("and the module rejects it too, when called directly", shortThrew)

console.log("\ndirect module checks")
const missing = await requestPasswordReset({ email: `ghost-${stamp}@example.com` })
check("requesting for an unknown address resolves rather than throwing", missing.sent === false)
check("and says why, for the operator's log", missing.reason.includes("no account"), missing.reason)

let threw = false
try {
  await consumePasswordReset("nonsense", "longenoughpassword")
} catch {
  threw = true
}
check("consuming a bad token throws", threw)

console.log("\ncleanup")
await db().execute({
  text: `DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
  values: [email],
})
await db().execute({
  text: `DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
  values: [email],
})
await db().execute({ text: `DELETE FROM users WHERE email = $1`, values: [email] })
await closeDb()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
