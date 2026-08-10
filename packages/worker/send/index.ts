import { config } from "@outbox/config"
import {
  allowedByTopic,
  appendOpenPixel,
  applyClickTracking,
  buildMime,
  emit,
  injectUnsubscribe,
  isSuppressed,
  loadBlob,
  type MimeAttachment,
  normalizeEmail,
  parseAddress,
  signDkim,
  unsubscribeUrl,
} from "@outbox/core"
import { db } from "@outbox/core/db"
import { transportFor } from "@outbox/delivery"
import {
  type Domain,
  domains,
  type Email,
  type EmailAttachment,
  emailAttachments,
  emailRecipients,
  emails,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"

const bodyFor = async (
  email: Email,
  domain: Domain | null,
  recipient: string,
): Promise<{ html: string | null; text: string | null }> => {
  let html = email.html
  let text = email.text

  // Unsubscribe placeholders resolve per recipient.
  if (html) html = injectUnsubscribe(html, email.id, recipient, email.topic_id)
  if (text) text = injectUnsubscribe(text, email.id, recipient, email.topic_id)

  if (html && domain?.click_tracking) {
    const tracked = await applyClickTracking(html, email.id, email.team_id, recipient, domain)
    html = tracked.html
  }
  if (html && domain?.open_tracking) {
    html = appendOpenPixel(html, email.id, recipient, domain)
  }
  return { html, text }
}

const attachmentsFor = async (emailId: string): Promise<MimeAttachment[]> => {
  const rows = await db().all<EmailAttachment>(
    from(emailAttachments).where((q) => q("email_id").equals(emailId)),
  )
  // Sequential rather than parallel: a message with many attachments would
  // otherwise open that many bucket connections at once, on every send, on
  // every worker. Attachments are rare and the queue is already concurrent.
  const out: MimeAttachment[] = []
  for (const a of rows) {
    out.push({
      filename: a.filename,
      content: await loadBlob(a),
      contentType: a.content_type,
      contentId: a.content_id,
    })
  }
  return out
}

export type SendOutcome = { status: "sent" | "skipped" | "failed"; detail: string }

/**
 * Renders, signs, and hands one stored email to the configured transport.
 * Suppression and topic checks run per recipient so a partial send still
 * reaches the addresses that are allowed.
 */
export const deliverEmail = async (emailId: string): Promise<SendOutcome> => {
  const conn = db()
  const email = await conn.one<Email>(from(emails).where((q) => q("id").equals(emailId)))
  if (!email) return { status: "skipped", detail: "email no longer exists" }
  if (email.canceled_at || email.last_event === "canceled") {
    return { status: "skipped", detail: "canceled" }
  }
  if (email.sent_at) return { status: "skipped", detail: "already sent" }

  const domain = email.domain_id
    ? await conn.one<Domain>(from(domains).where((q) => q("id").equals(email.domain_id!)))
    : null

  const recipientRows = await conn.all<{ address: string; kind: string }>(
    from(emailRecipients)
      .select("address", "kind")
      .where((q) => q("email_id").equals(emailId)),
  )
  const allAddresses = recipientRows.map((r) => normalizeEmail(r.address))

  const allowed: string[] = []
  for (const address of allAddresses) {
    if (await isSuppressed(email.team_id, address)) {
      await emit({
        teamId: email.team_id,
        type: "email.suppressed",
        emailId: email.id,
        recipient: address,
        data: { reason: "on suppression list" },
      })
      continue
    }
    if (email.topic_id && !(await allowedByTopic(email.team_id, email.topic_id, address))) {
      await emit({
        teamId: email.team_id,
        type: "email.failed",
        emailId: email.id,
        recipient: address,
        data: { reason: "recipient opted out of topic" },
      })
      continue
    }
    allowed.push(address)
  }

  if (allowed.length === 0) {
    await conn.execute(
      from(emails)
        .where((q) => q("id").equals(email.id))
        .update({ updated_at: new Date() }),
    )
    return { status: "skipped", detail: "every recipient was suppressed or opted out" }
  }

  // One MIME body per recipient, because tracking and unsubscribe links differ.
  const attachments = await attachmentsFor(email.id)
  const transport = transportFor()
  const fromAddress = parseAddress(email.from_address)
  const returnPath = domain
    ? `bounces+${email.id}@${domain.custom_return_path}.${domain.name}`
    : (fromAddress?.email ?? `noreply@${config.hostname}`)

  let anySent = false
  const responses: string[] = []

  for (const recipient of allowed) {
    const { html, text } = await bodyFor(email, domain, recipient)
    const listUnsubscribe =
      email.topic_id || domain?.click_tracking
        ? `<${unsubscribeUrl(email.id, recipient, email.topic_id)}>`
        : undefined

    const built = buildMime({
      from: email.from_address,
      to: [recipient],
      cc: email.cc ?? undefined,
      replyTo: email.reply_to ?? undefined,
      subject: email.subject,
      html,
      text,
      headers: email.headers ?? undefined,
      messageId: email.message_id ?? `<${email.id}@${config.hostname}>`,
      date: email.created_at,
      attachments,
      listUnsubscribe,
      listUnsubscribePost: Boolean(listUnsubscribe),
    })

    const raw =
      domain?.dkim_private_key && domain.status === "verified"
        ? signDkim(built.raw, {
            domain: domain.name,
            selector: domain.dkim_selector,
            privateKey: domain.dkim_private_key,
          })
        : built.raw

    const outcome = await transport.deliver({
      returnPath,
      recipients: [recipient],
      raw,
      tls: (domain?.tls as "opportunistic" | "enforced") ?? "opportunistic",
    })
    responses.push(outcome.response)

    if (outcome.ok) {
      anySent = true
      await emit({
        teamId: email.team_id,
        type: "email.sent",
        emailId: email.id,
        recipient,
        data: { response: outcome.response },
      })
      // Without a real MTA callback there is no separate delivery signal, so
      // the console transport reports delivery immediately.
      if (transport.name === "console") {
        await emit({
          teamId: email.team_id,
          type: "email.delivered",
          emailId: email.id,
          recipient,
        })
      }
    } else {
      const hard = outcome.bounceType === "hard"
      await conn.execute(
        from(emailRecipients)
          .where((q) => [q("email_id").equals(email.id), q("address").equals(recipient)])
          .update({ bounce_type: outcome.bounceType ?? null }),
      )
      await emit({
        teamId: email.team_id,
        type: hard ? "email.bounced" : "email.delivery_delayed",
        emailId: email.id,
        recipient,
        data: {
          bounce: { type: hard ? "Permanent" : "Transient", message: outcome.response },
        },
      })
      // A hard bounce suppresses the address so later sends skip it.
      if (hard) {
        await conn.execute({
          text: `INSERT INTO suppressions (team_id, email, origin, source_id, reason)
                 VALUES ($1, $2, 'bounce', $3, $4)
                 ON CONFLICT (team_id, email) DO NOTHING`,
          values: [email.team_id, recipient, email.id, outcome.response.slice(0, 500)],
        })
      }
      if (outcome.retryable) {
        throw new Error(`transient delivery failure: ${outcome.response}`)
      }
    }
  }

  await conn.execute(
    from(emails)
      .where((q) => q("id").equals(email.id))
      .update({ sent_at: new Date(), updated_at: new Date() }),
  )

  return anySent
    ? { status: "sent", detail: responses.join(" | ") }
    : { status: "failed", detail: responses.join(" | ") }
}
