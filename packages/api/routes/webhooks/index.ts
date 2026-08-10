import {
  EVENT_TYPES,
  logObject,
  notFound,
  paginate,
  parsePageQuery,
  signingSecret,
  webhookAttemptObject,
  webhookEventObject,
  webhookObject,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type ApiLog,
  apiLogs,
  type Webhook,
  type WebhookAttempt,
  type WebhookEvent,
  webhookAttempts,
  webhookEvents,
  webhooks,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const webhookParam = z.object({ webhook_id: z.string().uuid() })

const find = async (teamId: string, id: string): Promise<Webhook> => {
  const row = await db().one<Webhook>(
    from(webhooks).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Webhook not found")
  return row
}

const eventsSchema = z
  .array(z.string())
  .min(1)
  .refine((values) => values.every((v) => (EVENT_TYPES as readonly string[]).includes(v)), {
    message: `events must be a subset of: ${EVENT_TYPES.join(", ")}`,
  })

export const webhookRoutes: Route[] = [
  postR(
    "/webhooks",
    {
      body: z.object({ endpoint: z.string().url(), events: eventsSchema }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = (await db().one<Webhook>(
        from(webhooks)
          .insert({
            team_id: authOf(c).teamId,
            endpoint: c.body.endpoint,
            events: c.body.events,
            signing_secret: signingSecret(),
          })
          .returning(...allColumns(webhooks)),
      ))!
      return json(c, 201, webhookObject(row))
    },
  ),

  getR(
    "/webhooks",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Webhook>({
        table: "webhooks",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(webhookObject) })
    },
  ),

  getR(
    "/webhooks/:webhook_id/events/:event_id/attempts",
    {
      params: z.object({ webhook_id: z.string().uuid(), event_id: z.string().min(1) }),
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      await find(authOf(c).teamId, c.params.webhook_id)
      const rows = await db().all<WebhookAttempt>(
        from(webhookAttempts)
          .where((q) => [
            q("webhook_event_id").equals(c.params.event_id),
            q("webhook_id").equals(c.params.webhook_id),
          ])
          .orderBy("sent_at", "DESC"),
      )
      return json(c, 200, {
        object: "list",
        has_more: false,
        data: rows.map(webhookAttemptObject),
      })
    },
  ),

  getR(
    "/webhooks/:webhook_id/events/:event_id",
    {
      params: z.object({ webhook_id: z.string().uuid(), event_id: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      await find(authOf(c).teamId, c.params.webhook_id)
      const row = await db().one<WebhookEvent>(
        from(webhookEvents).where((q) => [
          q("id").equals(c.params.event_id),
          q("webhook_id").equals(c.params.webhook_id),
        ]),
      )
      if (!row) throw notFound("Event not found")
      return json(c, 200, webhookEventObject(row, true))
    },
  ),

  getR(
    "/webhooks/:webhook_id/events",
    {
      params: webhookParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      await find(teamId, c.params.webhook_id)
      const page = await paginate<WebhookEvent>({
        table: "webhook_events",
        teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        where: "webhook_id = $1",
        values: [c.params.webhook_id],
      })
      return json(c, 200, { ...page, data: page.data.map((e) => webhookEventObject(e)) })
    },
  ),

  getR(
    "/webhooks/:webhook_id",
    { params: webhookParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await find(authOf(c).teamId, c.params.webhook_id)
      return json(c, 200, webhookObject(row))
    },
  ),

  patchR(
    "/webhooks/:webhook_id",
    {
      params: webhookParam,
      body: z.object({
        endpoint: z.string().url().optional(),
        events: eventsSchema.optional(),
        status: z.enum(["enabled", "disabled"]).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await find(teamId, c.params.webhook_id)
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.endpoint !== undefined) patch.endpoint = c.body.endpoint
      if (c.body.events !== undefined) patch.events = c.body.events
      if (c.body.status !== undefined) patch.status = c.body.status
      await db().execute(
        from(webhooks)
          .where((q) => q("id").equals(row.id))
          .update(patch),
      )
      return json(c, 200, { object: "webhook", id: row.id })
    },
  ),

  delR(
    "/webhooks/:webhook_id",
    { params: webhookParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await find(teamId, c.params.webhook_id)
      await db().execute(
        from(webhooks)
          .where((q) => [q("id").equals(row.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, { object: "webhook", id: row.id, deleted: true })
    },
  ),
]

export const logRoutes: Route[] = [
  getR(
    "/logs",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<ApiLog>({
        table: "api_logs",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      return json(c, 200, { ...page, data: page.data.map((l) => logObject(l)) })
    },
  ),

  getR(
    "/logs/:log_id",
    { params: z.object({ log_id: z.string().uuid() }), before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await db().one<ApiLog>(
        from(apiLogs).where((q) => [
          q("id").equals(c.params.log_id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Log not found")
      return json(c, 200, logObject(row, true))
    },
  ),
]
