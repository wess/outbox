import {
  enqueue,
  invalidParameter,
  listEnvelope,
  normalizeEmail,
  notFound,
  paginate,
  parsePageQuery,
  pgTimestamp,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type Automation,
  type AutomationEdge,
  type AutomationRun,
  type AutomationRunStep,
  type AutomationStep,
  automationEdges,
  automationRunSteps,
  automationRuns,
  automationSteps,
  automations,
  type Contact,
  type CustomEvent,
  contacts,
  customEvents,
  eventDeliveries,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const STEP_TYPES = [
  "trigger",
  "condition",
  "delay",
  "wait_for_event",
  "send_email",
  "add_to_segment",
  "contact_update",
  "contact_delete",
] as const

const EDGE_TYPES = ["default", "condition_met", "condition_not_met"] as const

const stepSchema = z.object({
  key: z.string().min(1),
  type: z.enum(STEP_TYPES),
  config: z.record(z.unknown()).optional(),
})

const edgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(EDGE_TYPES).optional(),
})

const automationParam = z.object({ automation_id: z.string().uuid() })

const find = async (teamId: string, id: string): Promise<Automation> => {
  const row = await db().one<Automation>(
    from(automations).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Automation not found")
  return row
}

const graphOf = async (automationId: string) => {
  const steps = await db().all<AutomationStep>(
    from(automationSteps)
      .where((q) => q("automation_id").equals(automationId))
      .orderBy("position"),
  )
  const edges = await db().all<AutomationEdge>(
    from(automationEdges).where((q) => q("automation_id").equals(automationId)),
  )
  return { steps, edges }
}

const serialize = async (row: Automation) => {
  const { steps, edges } = await graphOf(row.id)
  return {
    object: "automation" as const,
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    created_at: pgTimestamp(row.created_at),
    updated_at: pgTimestamp(row.updated_at),
    steps: steps.map((s) => ({ key: s.key, type: s.type, config: s.config ?? {} })),
    edges: edges.map((e) => ({ from: e.from_key, to: e.to_key, type: e.type })),
  }
}

// Rewrites the whole graph so create and update share one code path.
const writeGraph = async (
  teamId: string,
  automationId: string,
  steps: z.infer<typeof stepSchema>[],
  edges: z.infer<typeof edgeSchema>[],
): Promise<void> => {
  const keys = new Set(steps.map((s) => s.key))
  for (const edge of edges) {
    if (!keys.has(edge.from))
      throw invalidParameter(`Edge references unknown step \`${edge.from}\`.`)
    if (!keys.has(edge.to)) throw invalidParameter(`Edge references unknown step \`${edge.to}\`.`)
  }
  const triggers = steps.filter((s) => s.type === "trigger")
  if (triggers.length !== 1) {
    throw invalidParameter("An automation must have exactly one `trigger` step.")
  }
  if (!triggers[0]!.config?.event_name) {
    throw invalidParameter("The trigger step requires `config.event_name`.")
  }

  const conn = db()
  await conn.execute(
    from(automationSteps)
      .where((q) => q("automation_id").equals(automationId))
      .del(),
  )
  await conn.execute(
    from(automationEdges)
      .where((q) => q("automation_id").equals(automationId))
      .del(),
  )
  await conn.execute(
    from(automationSteps).insertMany(
      steps.map((s, i) => ({
        automation_id: automationId,
        team_id: teamId,
        key: s.key,
        type: s.type,
        config: s.config ?? {},
        position: i,
      })),
    ),
  )
  if (edges.length) {
    await conn.execute(
      from(automationEdges).insertMany(
        edges.map((e) => ({
          automation_id: automationId,
          from_key: e.from,
          to_key: e.to,
          type: e.type ?? "default",
        })),
      ),
    )
  }
}

export const automationRoutes: Route[] = [
  postR(
    "/automations",
    {
      body: z.object({
        name: z.string().min(1),
        description: z.string().nullish(),
        status: z.enum(["enabled", "disabled"]).optional(),
        steps: z.array(stepSchema).min(1),
        edges: z.array(edgeSchema).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = (await db().one<Automation>(
        from(automations)
          .insert({
            team_id: teamId,
            name: c.body.name,
            description: c.body.description ?? null,
            status: c.body.status ?? "disabled",
          })
          .returning(...allColumns(automations)),
      ))!
      await writeGraph(teamId, row.id, c.body.steps, c.body.edges ?? [])
      return json(c, 201, await serialize(row))
    },
  ),

  getR(
    "/automations",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Automation>({
        table: "automations",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      const data = await Promise.all(page.data.map(serialize))
      return json(c, 200, { ...page, data })
    },
  ),

  getR(
    "/automations/events",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const rows = await db().all<CustomEvent>(
        from(customEvents)
          .where((q) => q("team_id").equals(authOf(c).teamId))
          .orderBy("name"),
      )
      return json(
        c,
        200,
        listEnvelope(
          rows.map((r) => ({
            object: "custom_event",
            id: r.id,
            name: r.name,
            description: r.description,
            created_at: pgTimestamp(r.created_at),
          })),
        ),
      )
    },
  ),

  postR(
    "/automations/events",
    {
      body: z.object({ name: z.string().min(1), description: z.string().nullish() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<CustomEvent>({
        text: `INSERT INTO custom_events (team_id, name, description) VALUES ($1, $2, $3)
               ON CONFLICT (team_id, name) DO UPDATE SET description = EXCLUDED.description
               RETURNING *`,
        values: [authOf(c).teamId, c.body.name, c.body.description ?? null],
      })
      return json(c, 201, { object: "custom_event", id: row!.id, name: row!.name })
    },
  ),

  getR(
    "/automations/:automation_id/runs",
    {
      params: automationParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      await find(teamId, c.params.automation_id)
      const rows = await db().all<AutomationRun>(
        from(automationRuns)
          .where((q) => [
            q("automation_id").equals(c.params.automation_id),
            q("team_id").equals(teamId),
          ])
          .orderBy("started_at", "DESC")
          .limit(Math.min(100, Number((c.query as Record<string, string>)?.limit ?? 20))),
      )
      return json(
        c,
        200,
        listEnvelope(
          rows.map((r) => ({
            object: "automation_run",
            id: r.id,
            contact_id: r.contact_id,
            email: r.email,
            status: r.status,
            current_step_key: r.current_step_key,
            resume_at: pgTimestamp(r.resume_at),
            started_at: pgTimestamp(r.started_at),
            completed_at: pgTimestamp(r.completed_at),
            error: r.error,
          })),
        ),
      )
    },
  ),

  getR(
    "/automations/:automation_id/runs/:run_id",
    {
      params: z.object({ automation_id: z.string().uuid(), run_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const run = await db().one<AutomationRun>(
        from(automationRuns).where((q) => [
          q("id").equals(c.params.run_id),
          q("automation_id").equals(c.params.automation_id),
          q("team_id").equals(teamId),
        ]),
      )
      if (!run) throw notFound("Automation run not found")
      const steps = await db().all<AutomationRunStep>(
        from(automationRunSteps)
          .where((q) => q("run_id").equals(run.id))
          .orderBy("created_at"),
      )
      return json(c, 200, {
        object: "automation_run",
        id: run.id,
        contact_id: run.contact_id,
        email: run.email,
        status: run.status,
        current_step_key: run.current_step_key,
        context: run.context ?? {},
        started_at: pgTimestamp(run.started_at),
        completed_at: pgTimestamp(run.completed_at),
        error: run.error,
        steps: steps.map((s) => ({
          key: s.step_key,
          type: s.step_type,
          status: s.status,
          result: s.result ?? {},
          error: s.error,
          created_at: pgTimestamp(s.created_at),
        })),
      })
    },
  ),

  getR(
    "/automations/:automation_id",
    { params: automationParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await find(authOf(c).teamId, c.params.automation_id)
      return json(c, 200, await serialize(row))
    },
  ),

  patchR(
    "/automations/:automation_id",
    {
      params: automationParam,
      body: z.object({
        name: z.string().optional(),
        description: z.string().nullish(),
        status: z.enum(["enabled", "disabled"]).optional(),
        steps: z.array(stepSchema).min(1).optional(),
        edges: z.array(edgeSchema).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await find(teamId, c.params.automation_id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.description !== undefined) patch.description = c.body.description
      if (c.body.status !== undefined) patch.status = c.body.status
      await db().execute(
        from(automations)
          .where((q) => q("id").equals(row.id))
          .update(patch),
      )

      if (c.body.steps) await writeGraph(teamId, row.id, c.body.steps, c.body.edges ?? [])

      return json(c, 200, await serialize(await find(teamId, row.id)))
    },
  ),

  delR(
    "/automations/:automation_id",
    { params: automationParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await find(teamId, c.params.automation_id)
      await db().execute(
        from(automations)
          .where((q) => [q("id").equals(row.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, { object: "automation", id: row.id, deleted: true })
    },
  ),
]

export const eventRoutes: Route[] = [
  postR(
    "/events/send",
    {
      body: z.object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        contact_id: z.string().uuid().optional(),
        data: z.record(z.unknown()).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      if (!c.body.email && !c.body.contact_id) {
        throw invalidParameter("Provide either `email` or `contact_id`.")
      }

      let contact: Contact | null = null
      if (c.body.contact_id) {
        contact = await db().one<Contact>(
          from(contacts).where((q) => [
            q("id").equals(c.body.contact_id!),
            q("team_id").equals(teamId),
          ]),
        )
      } else if (c.body.email) {
        contact = await db().one<Contact>(
          from(contacts).where((q) => [
            q("email").equals(normalizeEmail(c.body.email!)),
            q("team_id").equals(teamId),
          ]),
        )
      }

      const email = c.body.email ?? contact?.email ?? null
      const delivery = (await db().one<{ id: string }>(
        from(eventDeliveries)
          .insert({
            team_id: teamId,
            name: c.body.name,
            email,
            contact_id: contact?.id ?? null,
            data: c.body.data ?? {},
          })
          .returning("id"),
      ))!

      // Register the event name so it shows up in the dashboard picker.
      await db().execute({
        text: `INSERT INTO custom_events (team_id, name) VALUES ($1, $2)
               ON CONFLICT (team_id, name) DO NOTHING`,
        values: [teamId, c.body.name],
      })

      await enqueue({
        kind: "automation.start",
        payload: {
          eventName: c.body.name,
          email,
          contactId: contact?.id ?? null,
          data: c.body.data ?? {},
          deliveryId: delivery.id,
        },
        teamId,
      })

      return json(c, 200, { object: "event", id: delivery.id, name: c.body.name })
    },
  ),
]
