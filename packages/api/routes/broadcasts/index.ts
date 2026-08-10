import {
  broadcastListItem,
  broadcastObject,
  enqueue,
  entryToHtml,
  entryToText,
  inklingFor,
  invalidParameter,
  notFound,
  paginate,
  parsePageQuery,
  requireIntegration,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import { normalizeSchedule, parseScheduledAt } from "@outbox/core/scheduling"
import { type Broadcast, broadcasts } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const broadcastParam = z.object({ broadcast_id: z.string().uuid() })

const find = async (teamId: string, id: string): Promise<Broadcast> => {
  const row = await db().one<Broadcast>(
    from(broadcasts).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Broadcast not found")
  return row
}

const toArray = (v: string | string[] | undefined): string[] | null =>
  v === undefined ? null : Array.isArray(v) ? v : [v]

const RECIPIENT_TYPES = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "suppressed",
] as const

export const broadcastRoutes: Route[] = [
  postR(
    "/broadcasts",
    {
      body: z.object({
        segment_id: z.string().uuid().optional(),
        audience_id: z.string().uuid().optional(),
        from: z.string().min(1),
        subject: z.string().min(1).optional(),
        reply_to: z.union([z.string(), z.array(z.string())]).optional(),
        html: z.string().optional(),
        text: z.string().optional(),
        preview_text: z.string().optional(),
        name: z.string().optional(),
        topic_id: z.string().uuid().optional(),
        send: z.boolean().optional(),
        scheduled_at: z.string().optional(),
        // Pull the body from a connected CMS instead of supplying it inline.
        source: z
          .object({
            provider: z.literal("inkling"),
            type: z.string().min(1),
            slug: z.string().min(1),
          })
          .optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const segmentId = c.body.segment_id ?? c.body.audience_id
      if (!segmentId) throw invalidParameter("Missing `segment_id` field.")

      // A source fills in subject, html, and text; anything passed explicitly
      // still wins, so you can override just the subject.
      let sourced: { subject?: string; html?: string; text?: string } = {}
      if (c.body.source) {
        const integration = await requireIntegration(teamId, "inkling")
        const client = await inklingFor(teamId)
        const entry = await client.entry(c.body.source.type, c.body.source.slug)
        const settings = (integration.settings ?? {}) as {
          site_url?: string
          path_template?: string
        }
        sourced = {
          subject: entry.title,
          html: entryToHtml(entry, c.body.source.type, {
            siteUrl: settings.site_url ?? null,
            pathTemplate: settings.path_template,
            footerHtml: '<a href="{{{OUTBOX_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
          }),
          text: entryToText(entry, c.body.source.type, { siteUrl: settings.site_url ?? null }),
        }
      }

      const html = c.body.html ?? sourced.html ?? null
      const text = c.body.text ?? sourced.text ?? null
      const subject = c.body.subject ?? sourced.subject
      if (!html && !text) {
        throw invalidParameter("Missing one of `html`, `text`, or `source`.")
      }
      if (!subject) throw invalidParameter("Missing `subject` field.")

      const scheduledAt = normalizeSchedule(parseScheduledAt(c.body.scheduled_at))
      const willSend = c.body.send === true || Boolean(scheduledAt)

      const row = (await db().one<Broadcast>(
        from(broadcasts)
          .insert({
            team_id: teamId,
            segment_id: segmentId,
            topic_id: c.body.topic_id ?? null,
            name: c.body.name ?? subject,
            from_address: c.body.from,
            subject,
            preview_text: c.body.preview_text ?? null,
            reply_to: toArray(c.body.reply_to),
            html,
            text,
            status: willSend ? (scheduledAt ? "scheduled" : "sending") : "draft",
            scheduled_at: scheduledAt,
          })
          .returning(...allColumns(broadcasts)),
      ))!

      if (willSend) {
        await enqueue({
          kind: "broadcast.fanout",
          payload: { broadcastId: row.id },
          teamId,
          runAt: scheduledAt ?? new Date(),
        })
      }

      return json(c, 201, { object: "broadcast", id: row.id })
    },
  ),

  getR(
    "/broadcasts",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Broadcast>({
        table: "broadcasts",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(broadcastListItem) })
    },
  ),

  getR(
    "/broadcasts/:broadcast_id/metrics",
    { params: broadcastParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const broadcast = await find(teamId, c.params.broadcast_id)

      const counts = await db().all<{ type: string; total: string }>({
        text: `SELECT ev.type, count(DISTINCT ev.email_id) AS total
               FROM email_events ev
               JOIN emails e ON e.id = ev.email_id
               WHERE e.broadcast_id = $1
               GROUP BY ev.type`,
        values: [broadcast.id],
      })
      const byType = Object.fromEntries(
        counts.map((r) => [r.type.replace(/^email\./, ""), Number(r.total)]),
      )

      const totals = await db().one<{ total: string; sent: string }>({
        text: `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'sent') AS sent
               FROM broadcast_recipients WHERE broadcast_id = $1`,
        values: [broadcast.id],
      })
      const total = Number(totals?.total ?? 0)
      const sent = Number(totals?.sent ?? 0)

      const links = await db().all<{ url: string; clicks: string; unique_clicks: string }>({
        text: `SELECT tl.url,
                      count(ev.id) AS clicks,
                      count(DISTINCT ev.recipient) AS unique_clicks
               FROM tracking_links tl
               JOIN emails e ON e.id = tl.email_id
               LEFT JOIN email_events ev
                 ON ev.email_id = tl.email_id AND ev.type = 'email.clicked'
                AND ev.data->>'link_id' = tl.id::text
               WHERE e.broadcast_id = $1
               GROUP BY tl.url
               ORDER BY clicks DESC`,
        values: [broadcast.id],
      })

      const stat = (n: number) => ({
        count: n,
        percentage: total === 0 ? 0 : Math.round((n / total) * 10000) / 100,
      })

      return json(c, 200, {
        object: "broadcast_metrics",
        broadcast_id: broadcast.id,
        status: broadcast.status,
        created_at: broadcast.created_at,
        scheduled_at: broadcast.scheduled_at,
        sent_at: broadcast.sent_at,
        total,
        sent,
        remaining: Math.max(0, total - sent),
        delivered: stat(byType.delivered ?? 0),
        opened: stat(byType.opened ?? 0),
        clicked: stat(byType.clicked ?? 0),
        unsubscribed: stat(byType.unsubscribed ?? 0),
        bounced: stat(byType.bounced ?? 0),
        complained: stat(byType.complained ?? 0),
        suppressed: stat(byType.suppressed ?? 0),
        clicked_links: links.map((l) => ({
          url: l.url,
          clicks: Number(l.clicks),
          unique_clicks: Number(l.unique_clicks),
        })),
      })
    },
  ),

  getR(
    "/broadcasts/:broadcast_id/recipients",
    {
      params: broadcastParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const broadcast = await find(teamId, c.params.broadcast_id)
      const q = (c.query ?? {}) as Record<string, string>
      const type = q.type
      if (!type || !(RECIPIENT_TYPES as readonly string[]).includes(type)) {
        throw invalidParameter(`\`type\` must be one of: ${RECIPIENT_TYPES.join(", ")}.`)
      }

      const params: unknown[] = [broadcast.id, `email.${type}`]
      let extra = ""
      if (q.email) {
        params.push(q.email)
        extra += ` AND br.email = $${params.length}`
      }
      if (q.bounce_type) {
        params.push(q.bounce_type)
        extra += ` AND er.bounce_type = $${params.length}`
      }
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20)))

      const rows = await db().all<{
        id: string
        contact_id: string | null
        email: string
        count: string
        bounce_type: string | null
      }>({
        text: `SELECT br.id, br.contact_id, br.email,
                      count(ev.id) AS count,
                      max(er.bounce_type) AS bounce_type
               FROM broadcast_recipients br
               JOIN emails e ON e.id = br.email_id
               JOIN email_events ev ON ev.email_id = e.id AND ev.type = $2
               LEFT JOIN email_recipients er ON er.email_id = e.id AND er.address = br.email
               WHERE br.broadcast_id = $1${extra}
               GROUP BY br.id, br.contact_id, br.email
               ORDER BY br.created_at DESC
               LIMIT ${limit + 1}`,
        values: params,
      })

      const hasMore = rows.length > limit
      const data = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
        id: r.id,
        contact_id: r.contact_id,
        email: r.email,
        count: Number(r.count),
        bounce_type: r.bounce_type,
      }))
      return json(c, 200, { object: "list", has_more: hasMore, data })
    },
  ),

  postR(
    "/broadcasts/:broadcast_id/send",
    {
      params: broadcastParam,
      body: z.object({ scheduled_at: z.string().optional() }).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const broadcast = await find(teamId, c.params.broadcast_id)
      if (broadcast.status === "sent" || broadcast.status === "sending") {
        throw invalidParameter(`Broadcast is already ${broadcast.status}.`)
      }

      const scheduledAt = normalizeSchedule(parseScheduledAt(c.body?.scheduled_at))
      await db().execute(
        from(broadcasts)
          .where((q) => q("id").equals(broadcast.id))
          .update({
            status: scheduledAt ? "scheduled" : "sending",
            scheduled_at: scheduledAt,
            updated_at: new Date(),
          }),
      )
      await enqueue({
        kind: "broadcast.fanout",
        payload: { broadcastId: broadcast.id },
        teamId,
        runAt: scheduledAt ?? new Date(),
      })

      return json(c, 200, { object: "broadcast", id: broadcast.id })
    },
  ),

  getR(
    "/broadcasts/:broadcast_id",
    { params: broadcastParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await find(authOf(c).teamId, c.params.broadcast_id)
      return json(c, 200, broadcastObject(row))
    },
  ),

  patchR(
    "/broadcasts/:broadcast_id",
    {
      params: broadcastParam,
      body: z.object({
        segment_id: z.string().uuid().optional(),
        audience_id: z.string().uuid().optional(),
        from: z.string().optional(),
        subject: z.string().optional(),
        reply_to: z.union([z.string(), z.array(z.string())]).optional(),
        html: z.string().optional(),
        text: z.string().optional(),
        preview_text: z.string().optional(),
        name: z.string().optional(),
        topic_id: z.string().uuid().nullish(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const broadcast = await find(teamId, c.params.broadcast_id)
      if (broadcast.status === "sent" || broadcast.status === "sending") {
        throw invalidParameter("A broadcast that is sending or sent can no longer be edited.")
      }

      const patch: Record<string, unknown> = { updated_at: new Date() }
      const segmentId = c.body.segment_id ?? c.body.audience_id
      if (segmentId) patch.segment_id = segmentId
      if (c.body.from !== undefined) patch.from_address = c.body.from
      if (c.body.subject !== undefined) patch.subject = c.body.subject
      if (c.body.reply_to !== undefined) patch.reply_to = toArray(c.body.reply_to)
      if (c.body.html !== undefined) patch.html = c.body.html
      if (c.body.text !== undefined) patch.text = c.body.text
      if (c.body.preview_text !== undefined) patch.preview_text = c.body.preview_text
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.topic_id !== undefined) patch.topic_id = c.body.topic_id

      await db().execute(
        from(broadcasts)
          .where((q) => q("id").equals(broadcast.id))
          .update(patch),
      )
      return json(c, 200, { object: "broadcast", id: broadcast.id })
    },
  ),

  delR(
    "/broadcasts/:broadcast_id",
    { params: broadcastParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const broadcast = await find(teamId, c.params.broadcast_id)
      if (broadcast.status === "sending") {
        throw invalidParameter("A broadcast that is currently sending cannot be deleted.")
      }
      await db().execute(
        from(broadcasts)
          .where((q) => [q("id").equals(broadcast.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, { object: "broadcast", id: broadcast.id, deleted: true })
    },
  ),
]
