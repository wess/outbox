import {
  claimIdempotency,
  createEmail,
  emailListItem,
  emailObject,
  emit,
  invalidParameter,
  listEnvelope,
  loadBlob,
  loadText,
  notFound,
  paginate,
  parsePageQuery,
  pgTimestamp,
  receivedEmailObject,
  releaseIdempotency,
  type SendInput,
} from "@outbox/core"
import { db } from "@outbox/core/db"
import { normalizeSchedule, parseScheduledAt } from "@outbox/core/scheduling"
import {
  type Email,
  type EmailAttachment,
  emailAttachments,
  emails,
  type ReceivedEmail,
  type ReceivedEmailAttachment,
  receivedEmailAttachments,
  receivedEmails,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authed, authedFull, authOf } from "../../pipes/index.ts"
import { metricsRoutes } from "../metrics/index.ts"

const addressish = z.union([z.string(), z.array(z.string())])

const tagSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "Tag names may only contain letters, numbers, _ and -"),
  value: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "Tag values may only contain letters, numbers, _ and -"),
})

const attachmentSchema = z.object({
  content: z.union([z.string(), z.array(z.number())]).optional(),
  filename: z.string().optional(),
  path: z.string().url().optional(),
  content_type: z.string().optional(),
  content_id: z.string().optional(),
})

export const sendEmailSchema = z.object({
  from: z.string().optional(),
  to: addressish.optional(),
  cc: addressish.optional(),
  bcc: addressish.optional(),
  reply_to: addressish.optional(),
  subject: z.string().optional(),
  html: z.string().nullish(),
  text: z.string().nullish(),
  headers: z.record(z.string()).optional(),
  tags: z.array(tagSchema).optional(),
  topic_id: z.string().uuid().optional(),
  scheduled_at: z.string().optional(),
  attachments: z.array(attachmentSchema).optional(),
  template: z.object({ id: z.string(), variables: z.record(z.unknown()).optional() }).optional(),
})

const idParam = z.object({ id: z.string().uuid() })

const findEmail = async (teamId: string, id: string): Promise<Email> => {
  const row = await db().one<Email>(
    from(emails).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Email not found")
  return row
}

export const emailRoutes: Route[] = [
  // Static paths must precede /emails/:id so they are not swallowed by it.
  ...metricsRoutes,

  getR(
    "/emails/receiving",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<ReceivedEmail>({
        table: "received_emails",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(receivedEmailObject) })
    },
  ),

  getR(
    "/emails/receiving/:email_id/attachments",
    {
      params: z.object({ email_id: z.string().uuid() }),
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const page = await paginate<ReceivedEmailAttachment>({
        table: "received_email_attachments",
        teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        where: "received_email_id = $1",
        values: [c.params.email_id],
        alwaysPaginate: false,
      })
      return json(c, 200, {
        ...page,
        data: page.data.map((a) => ({
          object: "attachment",
          id: a.id,
          filename: a.filename,
          content_type: a.content_type,
          content_id: a.content_id,
          size: a.size,
          created_at: pgTimestamp(a.created_at),
        })),
      })
    },
  ),

  getR(
    "/emails/receiving/:email_id/attachments/:id",
    {
      params: z.object({ email_id: z.string().uuid(), id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<ReceivedEmailAttachment>(
        from(receivedEmailAttachments).where((q) => [
          q("id").equals(c.params.id),
          q("received_email_id").equals(c.params.email_id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Attachment not found")
      // Always base64 in the response, whichever way the bytes were stored —
      // where a blob lives is an operator's concern, not the API's.
      return json(c, 200, {
        object: "attachment",
        id: row.id,
        filename: row.filename,
        content_type: row.content_type,
        content_id: row.content_id,
        size: row.size,
        content: (await loadBlob(row)).toString("base64"),
        created_at: pgTimestamp(row.created_at),
      })
    },
  ),

  getR(
    "/emails/receiving/:id",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await db().one<ReceivedEmail>(
        from(receivedEmails).where((q) => [
          q("id").equals(c.params.id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Received email not found")
      return json(c, 200, receivedEmailObject(row))
    },
  ),

  // The archived message exactly as it arrived. Worth having as its own route
  // rather than a field on the object above: it is the one thing that settles an
  // argument about what a sender actually transmitted, and it is far too big to
  // return on every read of an inbox listing.
  getR(
    "/emails/receiving/:id/raw",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await db().one<ReceivedEmail>(
        from(receivedEmails).where((q) => [
          q("id").equals(c.params.id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Received email not found")
      const raw = await loadText(row)
      if (raw === null) throw notFound("Raw message is not available for this email")
      return {
        ...c,
        status: 200,
        body: raw,
        respHeaders: new Headers([
          ...c.respHeaders,
          ["content-type", "message/rfc822"],
          ["content-disposition", `attachment; filename="${row.id}.eml"`],
        ]),
      }
    },
  ),

  postR("/emails", { body: sendEmailSchema, before: authed, assigns: {} as never }, async (c) => {
    const auth = authOf(c)
    const key = c.headers.get("idempotency-key")

    const run = async () => {
      const email = await createEmail(c.body as SendInput, {
        teamId: auth.teamId,
        apiKeyId: auth.apiKeyId,
        idempotencyKey: key,
      })
      return { id: email.id }
    }

    if (!key) return json(c, 200, await run())

    const claim = await claimIdempotency(auth.teamId, key, c.body)
    if (claim.kind === "replay") return json(c, claim.status, claim.body)
    try {
      const body = await run()
      await claim.commit(200, body)
      return json(c, 200, body)
    } catch (err) {
      await releaseIdempotency(auth.teamId, key)
      throw err
    }
  }),

  postR(
    "/emails/batch",
    { body: z.array(sendEmailSchema).min(1).max(100), before: authed, assigns: {} as never },
    async (c) => {
      const auth = authOf(c)
      const key = c.headers.get("idempotency-key")

      const run = async () => {
        const data: { id: string }[] = []
        for (const item of c.body) {
          const email = await createEmail(item as SendInput, {
            teamId: auth.teamId,
            apiKeyId: auth.apiKeyId,
          })
          data.push({ id: email.id })
        }
        return { data }
      }

      if (!key) return json(c, 200, await run())

      const claim = await claimIdempotency(auth.teamId, key, c.body)
      if (claim.kind === "replay") return json(c, claim.status, claim.body)
      try {
        const body = await run()
        await claim.commit(200, body)
        return json(c, 200, body)
      } catch (err) {
        await releaseIdempotency(auth.teamId, key)
        throw err
      }
    },
  ),

  getR(
    "/emails",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Email>({
        table: "emails",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      return json(c, 200, { ...page, data: page.data.map(emailListItem) })
    },
  ),

  getR(
    "/emails/:email_id/attachments",
    {
      params: z.object({ email_id: z.string().uuid() }),
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      await findEmail(teamId, c.params.email_id)
      const rows = await db().all<EmailAttachment>(
        from(emailAttachments).where((q) => [
          q("email_id").equals(c.params.email_id),
          q("team_id").equals(teamId),
        ]),
      )
      return json(
        c,
        200,
        listEnvelope(
          rows.map((a) => ({
            object: "attachment",
            id: a.id,
            filename: a.filename,
            content_type: a.content_type,
            content_id: a.content_id,
            size: a.size,
            created_at: pgTimestamp(a.created_at),
          })),
        ),
      )
    },
  ),

  getR(
    "/emails/:email_id/attachments/:id",
    {
      params: z.object({ email_id: z.string().uuid(), id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<EmailAttachment>(
        from(emailAttachments).where((q) => [
          q("id").equals(c.params.id),
          q("email_id").equals(c.params.email_id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Attachment not found")
      // Always base64 in the response, whichever way the bytes were stored —
      // where a blob lives is an operator's concern, not the API's.
      return json(c, 200, {
        object: "attachment",
        id: row.id,
        filename: row.filename,
        content_type: row.content_type,
        content_id: row.content_id,
        size: row.size,
        content: (await loadBlob(row)).toString("base64"),
        created_at: pgTimestamp(row.created_at),
      })
    },
  ),

  getR("/emails/:id", { params: idParam, before: authedFull, assigns: {} as never }, async (c) => {
    const row = await findEmail(authOf(c).teamId, c.params.id)
    return json(c, 200, emailObject(row, { full: true }))
  }),

  patchR(
    "/emails/:id",
    {
      params: idParam,
      body: z.object({ scheduled_at: z.string() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const email = await findEmail(teamId, c.params.id)
      if (email.last_event !== "scheduled") {
        throw invalidParameter("Only scheduled emails can be rescheduled.")
      }
      const at = normalizeSchedule(parseScheduledAt(c.body.scheduled_at))
      if (!at) throw invalidParameter("`scheduled_at` must be in the future.")

      await db().execute(
        from(emails)
          .where((q) => [q("id").equals(email.id), q("team_id").equals(teamId)])
          .update({ scheduled_at: at, updated_at: new Date() }),
      )
      await db().execute({
        text: `UPDATE jobs SET run_at = $2, updated_at = now()
               WHERE kind = 'email.send' AND status = 'pending' AND payload->>'emailId' = $1`,
        values: [email.id, at],
      })
      return json(c, 200, { object: "email", id: email.id })
    },
  ),

  postR(
    "/emails/:id/cancel",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const email = await findEmail(teamId, c.params.id)
      if (email.last_event !== "scheduled") {
        throw invalidParameter("Only scheduled emails can be canceled.")
      }
      await db().execute(
        from(emails)
          .where((q) => [q("id").equals(email.id), q("team_id").equals(teamId)])
          .update({ last_event: "canceled", canceled_at: new Date(), updated_at: new Date() }),
      )
      await db().execute({
        text: `UPDATE jobs SET status = 'done', updated_at = now()
               WHERE kind = 'email.send' AND status = 'pending' AND payload->>'emailId' = $1`,
        values: [email.id],
      })
      await emit({
        teamId,
        type: "email.failed",
        emailId: email.id,
        updateLastEvent: false,
        data: { reason: "canceled" },
      })
      return json(c, 200, { object: "email", id: email.id })
    },
  ),

  delR("/emails/:id", { params: idParam, before: authedFull, assigns: {} as never }, async (c) => {
    const teamId = authOf(c).teamId
    await findEmail(teamId, c.params.id)
    await db().execute(
      from(emails)
        .where((q) => [q("id").equals(c.params.id), q("team_id").equals(teamId)])
        .del(),
    )
    return json(c, 200, { object: "email", id: c.params.id, deleted: true })
  }),
]
