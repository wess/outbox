/**
 * Turning a bounce or complaint into a decision.
 *
 * The SMTP transport already catches rejections that happen during the
 * conversation. This is the other half: failures the receiving server reports
 * *after* accepting the message, which is most of them. Without it the
 * suppression list only ever learns about addresses that fail fast, and Outbox
 * keeps mailing dead mailboxes — the exact thing the list exists to prevent.
 */
import { type Email, emailRecipients, emails } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { normalizeEmail } from "../addresses/index.ts"
import { db } from "../db/index.ts"
import { emit } from "../events/index.ts"

export type Severity = "hard" | "soft" | "complaint" | "delivered" | "unknown"

export type BounceInput = {
  teamId: string
  /** From the VERP tag when present — the most reliable attribution. */
  emailId?: string | null
  /** Fallback attribution when the report echoes the original Message-ID. */
  messageId?: string | null
  recipient?: string | null
  severity: Severity
  status?: string | null
  detail?: string | null
  reportingMta?: string | null
}

export type BounceOutcome = {
  applied: boolean
  reason: string
  emailId?: string
  recipient?: string
  suppressed?: boolean
}

const findEmail = async (input: BounceInput): Promise<Email | null> => {
  if (input.emailId) {
    const byId = await db().one<Email>(
      from(emails).where((q) => [
        q("id").equals(input.emailId!),
        q("team_id").equals(input.teamId),
      ]),
    )
    if (byId) return byId
  }

  if (input.messageId) {
    // Message-IDs are angle-bracketed on the wire and sometimes not in reports.
    const bare = input.messageId.replace(/^<|>$/g, "")
    return db().one<Email>({
      text: `SELECT * FROM emails
             WHERE team_id = $1 AND (message_id = $2 OR message_id = '<' || $2 || '>')
             LIMIT 1`,
      values: [input.teamId, bare],
    })
  }

  return null
}

/**
 * Picks which address the report is about. A DSN names the failed recipient,
 * but not every MTA includes it — falling back to the email's sole recipient is
 * safe, and refusing to guess between several is safer than suppressing the
 * wrong person.
 */
const resolveRecipient = async (
  email: Email,
  reported: string | null | undefined,
): Promise<string | null> => {
  if (reported) return normalizeEmail(reported)

  const rows = await db().all<{ address: string }>(
    from(emailRecipients)
      .select("address")
      .where((q) => q("email_id").equals(email.id)),
  )
  return rows.length === 1 ? normalizeEmail(rows[0]!.address) : null
}

const suppress = async (
  teamId: string,
  address: string,
  origin: "bounce" | "complaint",
  sourceId: string,
  reason: string | null,
): Promise<void> => {
  await db().execute({
    text: `INSERT INTO suppressions (team_id, email, origin, source_id, reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (team_id, email) DO NOTHING`,
    values: [teamId, address, origin, sourceId, reason?.slice(0, 500) ?? null],
  })
}

/**
 * Applies one verdict. Idempotent by intent: replayed reports re-emit an event
 * but cannot double-suppress, and a soft bounce never overwrites a hard one.
 */
export const recordBounce = async (input: BounceInput): Promise<BounceOutcome> => {
  if (input.severity === "delivered" || input.severity === "unknown") {
    return { applied: false, reason: `nothing to do for a ${input.severity} report` }
  }

  const email = await findEmail(input)
  if (!email) {
    return { applied: false, reason: "could not attribute the report to a sent email" }
  }

  const recipient = await resolveRecipient(email, input.recipient)
  if (!recipient) {
    return {
      applied: false,
      reason: "report named no recipient and the email had several",
      emailId: email.id,
    }
  }

  const detail = input.detail ?? input.status ?? null

  if (input.severity === "soft") {
    await emit({
      teamId: input.teamId,
      type: "email.delivery_delayed",
      emailId: email.id,
      recipient,
      data: {
        bounce: { type: "Transient", message: detail, status: input.status ?? null },
        reporting_mta: input.reportingMta ?? null,
      },
    })
    await db().execute(
      from(emailRecipients)
        .where((q) => [q("email_id").equals(email.id), q("address").equals(recipient)])
        .update({ bounce_type: "soft" }),
    )
    return { applied: true, reason: "recorded a transient failure", emailId: email.id, recipient }
  }

  if (input.severity === "complaint") {
    await emit({
      teamId: input.teamId,
      type: "email.complained",
      emailId: email.id,
      recipient,
      data: { complaint: { message: detail } },
    })
    await suppress(input.teamId, recipient, "complaint", email.id, detail)
    return {
      applied: true,
      reason: "recorded a complaint and suppressed the address",
      emailId: email.id,
      recipient,
      suppressed: true,
    }
  }

  // hard
  await emit({
    teamId: input.teamId,
    type: "email.bounced",
    emailId: email.id,
    recipient,
    data: {
      bounce: { type: "Permanent", message: detail, status: input.status ?? null },
      reporting_mta: input.reportingMta ?? null,
    },
  })
  await db().execute(
    from(emailRecipients)
      .where((q) => [q("email_id").equals(email.id), q("address").equals(recipient)])
      .update({ bounce_type: "hard" }),
  )
  await suppress(input.teamId, recipient, "bounce", email.id, detail)

  return {
    applied: true,
    reason: "recorded a permanent failure and suppressed the address",
    emailId: email.id,
    recipient,
    suppressed: true,
  }
}
