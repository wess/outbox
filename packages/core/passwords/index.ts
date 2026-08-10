/**
 * Password reset.
 *
 * The whole flow is built around not telling an anonymous caller anything they
 * did not already know. Asking to reset an address that has no account looks
 * exactly like asking to reset one that does, because the difference is a free
 * account-enumeration oracle on an endpoint that by definition needs no
 * credentials.
 *
 * Tokens are random, stored only as a hash, single-use, and short-lived. A
 * successful reset revokes every session the account had, on the assumption
 * that someone resetting a password may be doing it because someone else has
 * been using it.
 */

import { randomBytes } from "node:crypto"
import { config } from "@outbox/config"
import { type Domain, type User, users } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { normalizeEmail } from "../addresses/index.ts"
import { hashToken } from "../auth/index.ts"
import { db } from "../db/index.ts"
import { invalidParameter } from "../errors/index.ts"
import { createEmail } from "../sending/index.ts"

/** Long enough that guessing is hopeless; short-lived regardless. */
const TOKEN_BYTES = 32
export const RESET_TTL_SECONDS = 60 * 60

/**
 * How many live tokens one account may have. Not really a security control —
 * the tokens are unguessable — but it stops a stranger who knows your address
 * from using this endpoint to post you a hundred emails.
 */
const MAX_LIVE_TOKENS = 5

const hash = (password: string) => Bun.password.hash(password)

export type ResetRequest = {
  email: string
  ip?: string | null
  /** Where the reset form lives. Defaults to the dashboard on this instance. */
  resetUrl?: string
}

const resetLink = (token: string, base?: string): string => {
  const root = (base ?? `${config.publicUrl}/app/reset-password`).replace(/\/+$/, "")
  return `${root}?token=${encodeURIComponent(token)}`
}

/**
 * Picks the address reset mail is sent from.
 *
 * `AUTH_FROM` when set. Otherwise the first verified sending domain, which is
 * the only address on a fresh instance that can actually deliver — using
 * anything else produces mail that fails SPF and lands in spam, if it leaves at
 * all.
 */
const senderAddress = async (): Promise<string | null> => {
  if (config.authFrom) return config.authFrom

  const domain = await db().one<Domain>({
    text: `SELECT * FROM domains
           WHERE status = 'verified' AND sending = 'enabled'
           ORDER BY created_at LIMIT 1`,
    values: [],
  })
  return domain ? `no-reply@${domain.name}` : null
}

const body = (link: string) => ({
  subject: "Reset your Outbox password",
  text: [
    "Someone asked to reset the password on your Outbox account.",
    "",
    "Open this link to choose a new one:",
    link,
    "",
    `The link works once and expires in ${Math.round(RESET_TTL_SECONDS / 60)} minutes.`,
    "",
    "If this was not you, you can ignore this email — nothing has changed, and",
    "whoever asked cannot see whether an account exists here.",
  ].join("\n"),
  html: `
    <p>Someone asked to reset the password on your Outbox account.</p>
    <p><a href="${link}">Choose a new password</a></p>
    <p style="color:#666;font-size:14px">
      The link works once and expires in ${Math.round(RESET_TTL_SECONDS / 60)} minutes.
    </p>
    <p style="color:#666;font-size:14px">
      If this was not you, you can ignore this email — nothing has changed, and
      whoever asked cannot see whether an account exists here.
    </p>
    <p style="color:#999;font-size:12px">${link}</p>
  `,
})

export type ResetOutcome = {
  /** Whether mail actually went out. Never surfaced to an anonymous caller. */
  sent: boolean
  reason: string
}

/**
 * Always resolves. The caller is expected to answer the same way whatever
 * happens here, so a failure is logged for the operator rather than returned to
 * whoever asked.
 */
export const requestPasswordReset = async (input: ResetRequest): Promise<ResetOutcome> => {
  const email = normalizeEmail(input.email)

  const user = await db().one<User>(from(users).where((q) => q("email").equals(email)))
  if (!user) return { sent: false, reason: "no account with that address" }

  const live = await db().one<{ n: number }>({
    text: `SELECT count(*)::int AS n FROM password_resets
           WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()`,
    values: [user.id],
  })
  if ((live?.n ?? 0) >= MAX_LIVE_TOKENS) {
    return { sent: false, reason: "too many reset requests outstanding for this account" }
  }

  const sender = await senderAddress()
  if (!sender) {
    // Worth being loud about: from the outside this is indistinguishable from a
    // working reset, so the operator is the only one who can notice.
    console.warn(
      "[outbox] password reset requested but no verified sending domain exists — " +
        "set AUTH_FROM or verify a domain, or nobody can ever reset a password",
    )
    return { sent: false, reason: "no verified sending domain and AUTH_FROM is unset" }
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url")
  await db().execute({
    text: `INSERT INTO password_resets (token_hash, user_id, ip, expires_at)
           VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    values: [hashToken(token), user.id, input.ip ?? null, String(RESET_TTL_SECONDS)],
  })

  const link = resetLink(token, input.resetUrl)
  const content = body(link)

  // Sent through the ordinary pipeline rather than straight to the transport,
  // so it is queued, retried, logged and signed like any other message. One
  // consequence worth knowing: a suppressed address will not receive this.
  // That is correct in general and infuriating if it happens to be yours — the
  // log line above is where it shows up.
  const team = await db().one<{ team_id: string }>({
    text: `SELECT team_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1`,
    values: [user.id],
  })
  if (!team) return { sent: false, reason: "account belongs to no team" }

  await createEmail(
    { from: `Outbox <${sender}>`, to: [email], ...content },
    { teamId: team.team_id },
  )

  return { sent: true, reason: "reset email queued" }
}

export type ResetResult = { userId: string }

/**
 * Spends a token and sets the new password.
 *
 * Deliberately gives the same message for a token that never existed, one that
 * expired, and one already used: the difference is only useful to someone
 * probing, and someone with a genuine stale link needs the same next step in
 * every case.
 */
export const consumePasswordReset = async (
  token: string,
  password: string,
): Promise<ResetResult> => {
  if (password.length < 8) {
    throw invalidParameter("Password must be at least 8 characters.")
  }

  // Claims the token and marks it used in one statement, so two requests
  // arriving together cannot both succeed.
  const row = await db().one<{ user_id: string }>({
    text: `UPDATE password_resets
              SET used_at = now()
            WHERE token_hash = $1
              AND used_at IS NULL
              AND expires_at > now()
        RETURNING user_id`,
    values: [hashToken(token)],
  })
  if (!row) {
    throw invalidParameter("This reset link is no longer valid. Request a new one.")
  }

  await db().execute(
    from(users)
      .where((q) => q("id").equals(row.user_id))
      .update({ password_hash: await hash(password), updated_at: new Date() }),
  )

  // Anyone who was signed in as this account is signed out. If the reset
  // happened because someone else had the password, leaving their session alive
  // would defeat the point.
  await db().execute({
    text: `UPDATE sessions SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL`,
    values: [row.user_id],
  })

  // Any other outstanding token for this account is now moot.
  await db().execute({
    text: `UPDATE password_resets SET used_at = now()
           WHERE user_id = $1 AND used_at IS NULL`,
    values: [row.user_id],
  })

  return { userId: row.user_id }
}

/** Housekeeping: drop spent and expired tokens. */
export const prunePasswordResets = async (): Promise<number> => {
  const rows = await db().all<{ token_hash: string }>({
    text: `DELETE FROM password_resets
           WHERE expires_at < now() - interval '7 days'
           RETURNING token_hash`,
    values: [],
  })
  return rows.length
}
