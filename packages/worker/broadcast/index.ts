import { allowedByTopic, contactContext, createEmail, isSuppressed, render } from "@outbox/core"
import { db } from "@outbox/core/db"
import { type Broadcast, broadcastRecipients, broadcasts, type Contact } from "@outbox/schema"
import { from } from "@wess/atlas/db"

const BATCH = 500

type ContactRow = Contact & { properties: Record<string, unknown> }

const contactsInSegment = async (
  teamId: string,
  segmentId: string,
  offset: number,
): Promise<ContactRow[]> => {
  const rows = await db().all<Contact>({
    text: `SELECT c.* FROM contacts c
           JOIN segment_contacts sc ON sc.contact_id = c.id
           WHERE sc.segment_id = $1 AND c.team_id = $2
           ORDER BY c.created_at, c.id
           LIMIT $3 OFFSET $4`,
    values: [segmentId, teamId, BATCH, offset],
  })
  if (rows.length === 0) return []

  const props = await db().all<{ contact_id: string; key: string; value: string; type: string }>({
    text: `SELECT v.contact_id, p.key, v.value, p.type
           FROM contact_property_values v
           JOIN contact_properties p ON p.id = v.property_id
           WHERE v.contact_id = ANY(SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    values: [rows.map((r) => r.id)],
  })
  const byContact = new Map<string, Record<string, unknown>>()
  for (const p of props) {
    const bag = byContact.get(p.contact_id) ?? {}
    bag[p.key] = p.type === "number" ? Number(p.value) : p.value
    byContact.set(p.contact_id, bag)
  }

  return rows.map((r) => ({ ...r, properties: byContact.get(r.id) ?? {} }))
}

/**
 * Expands a broadcast into one email per eligible contact. Unsubscribed,
 * suppressed, and topic-opted-out contacts are recorded as skipped so the
 * metrics endpoint can report why.
 */
export const fanOutBroadcast = async (
  broadcastId: string,
): Promise<{ queued: number; skipped: number }> => {
  const conn = db()
  const broadcast = await conn.one<Broadcast>(
    from(broadcasts).where((q) => q("id").equals(broadcastId)),
  )
  if (!broadcast) return { queued: 0, skipped: 0 }
  if (broadcast.status === "sent" || broadcast.canceled_at) return { queued: 0, skipped: 0 }
  if (!broadcast.segment_id) {
    await conn.execute(
      from(broadcasts)
        .where((q) => q("id").equals(broadcast.id))
        .update({ status: "draft" }),
    )
    return { queued: 0, skipped: 0 }
  }

  await conn.execute(
    from(broadcasts)
      .where((q) => q("id").equals(broadcast.id))
      .update({ status: "sending" }),
  )

  let offset = 0
  let queued = 0
  let skipped = 0

  for (;;) {
    const contacts = await contactsInSegment(broadcast.team_id, broadcast.segment_id, offset)
    if (contacts.length === 0) break
    offset += contacts.length

    for (const contact of contacts) {
      const already = await conn.one<{ id: string }>(
        from(broadcastRecipients)
          .select("id")
          .where((q) => [
            q("broadcast_id").equals(broadcast.id),
            q("contact_id").equals(contact.id),
          ]),
      )
      if (already) continue

      const skip = async (reason: string) => {
        skipped++
        await conn.execute(
          from(broadcastRecipients).insert({
            broadcast_id: broadcast.id,
            team_id: broadcast.team_id,
            contact_id: contact.id,
            email: contact.email,
            status: "skipped",
            skip_reason: reason,
          }),
        )
      }

      if (contact.unsubscribed) {
        await skip("unsubscribed")
        continue
      }
      if (await isSuppressed(broadcast.team_id, contact.email)) {
        await skip("suppressed")
        continue
      }
      if (
        broadcast.topic_id &&
        !(await allowedByTopic(broadcast.team_id, broadcast.topic_id, contact.email))
      ) {
        await skip("opted out of topic")
        continue
      }

      const ctx = contactContext(contact)
      const email = await createEmail(
        {
          from: broadcast.from_address,
          to: contact.email,
          subject: render(broadcast.subject, ctx),
          html: broadcast.html ? render(broadcast.html, ctx) : null,
          text: broadcast.text ? render(broadcast.text, ctx) : null,
          reply_to: broadcast.reply_to ?? undefined,
          topic_id: broadcast.topic_id ?? undefined,
        },
        {
          teamId: broadcast.team_id,
          broadcastId: broadcast.id,
          contactId: contact.id,
        },
      )

      await conn.execute(
        from(broadcastRecipients).insert({
          broadcast_id: broadcast.id,
          team_id: broadcast.team_id,
          contact_id: contact.id,
          email_id: email.id,
          email: contact.email,
          status: "sent",
        }),
      )
      queued++
    }
  }

  await conn.execute(
    from(broadcasts)
      .where((q) => q("id").equals(broadcast.id))
      .update({
        status: "sent",
        sent_at: new Date(),
        total: queued + skipped,
        updated_at: new Date(),
      }),
  )

  return { queued, skipped }
}
