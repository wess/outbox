import { contactContext, createEmail, enqueue, render } from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type Automation,
  type AutomationEdge,
  type AutomationRun,
  type AutomationStep,
  automationEdges,
  automationRunSteps,
  automationRuns,
  automationSteps,
  automations,
  type Contact,
  contacts,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"

type Graph = { steps: Map<string, AutomationStep>; edges: AutomationEdge[] }

const loadGraph = async (automationId: string): Promise<Graph> => {
  const steps = await db().all<AutomationStep>(
    from(automationSteps).where((q) => q("automation_id").equals(automationId)),
  )
  const edges = await db().all<AutomationEdge>(
    from(automationEdges).where((q) => q("automation_id").equals(automationId)),
  )
  return { steps: new Map(steps.map((s) => [s.key, s])), edges }
}

const nextKey = (graph: Graph, fromKey: string, type = "default"): string | null =>
  graph.edges.find((e) => e.from_key === fromKey && e.type === type)?.to_key ?? null

// Reads `event.plan`, `contact.first_name`, or a bare property name.
const resolveField = (field: string, ctx: Record<string, unknown>): unknown => {
  const parts = field.split(".")
  let current: unknown = ctx
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const compare = (left: unknown, operator: string, right: unknown): boolean => {
  const ls = left === null || left === undefined ? "" : String(left)
  const rs = right === null || right === undefined ? "" : String(right)
  const ln = Number(left)
  const rn = Number(right)
  const numeric = Number.isFinite(ln) && Number.isFinite(rn)

  switch (operator) {
    case "eq":
      return numeric ? ln === rn : ls === rs
    case "neq":
      return numeric ? ln !== rn : ls !== rs
    case "gt":
      return numeric && ln > rn
    case "gte":
      return numeric && ln >= rn
    case "lt":
      return numeric && ln < rn
    case "lte":
      return numeric && ln <= rn
    case "contains":
      return ls.includes(rs)
    case "not_contains":
      return !ls.includes(rs)
    case "starts_with":
      return ls.startsWith(rs)
    case "ends_with":
      return ls.endsWith(rs)
    case "exists":
      return left !== undefined && left !== null && ls !== ""
    case "not_exists":
      return left === undefined || left === null || ls === ""
    default:
      return false
  }
}

type Rule = { type?: string; field?: string; operator?: string; value?: unknown; rules?: Rule[] }

const evaluate = (rule: Rule, ctx: Record<string, unknown>): boolean => {
  if (rule.type === "and" || rule.type === "all") {
    return (rule.rules ?? []).every((r) => evaluate(r, ctx))
  }
  if (rule.type === "or" || rule.type === "any") {
    return (rule.rules ?? []).some((r) => evaluate(r, ctx))
  }
  if (!rule.field || !rule.operator) return false
  return compare(resolveField(rule.field, ctx), rule.operator, rule.value)
}

const DURATION_UNITS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 604800,
}

const delaySeconds = (config: Record<string, unknown>): number => {
  if (typeof config.seconds === "number") return config.seconds
  const amount = Number(config.duration ?? config.amount ?? 0)
  const unit = String(config.unit ?? "seconds")
  return Number.isFinite(amount) ? amount * (DURATION_UNITS[unit] ?? 1) : 0
}

const recordStep = async (
  runId: string,
  step: AutomationStep,
  status: string,
  result?: Record<string, unknown>,
  error?: string,
): Promise<void> => {
  await db().execute(
    from(automationRunSteps).insert({
      run_id: runId,
      step_key: step.key,
      step_type: step.type,
      status,
      result: result ?? null,
      error: error ?? null,
    }),
  )
}

const finish = async (runId: string, status: string, error?: string): Promise<void> => {
  await db().execute(
    from(automationRuns)
      .where((q) => q("id").equals(runId))
      .update({
        status,
        completed_at: new Date(),
        current_step_key: null,
        resume_at: null,
        ...(error ? { error } : {}),
      }),
  )
}

/** Starts a run for every enabled automation whose trigger matches the event. */
export const startAutomations = async (input: {
  teamId: string
  eventName: string
  email: string | null
  contactId: string | null
  data: Record<string, unknown>
}): Promise<number> => {
  const conn = db()
  const candidates = await conn.all<Automation>(
    from(automations).where((q) => [
      q("team_id").equals(input.teamId),
      q("status").equals("enabled"),
    ]),
  )

  let started = 0
  for (const automation of candidates) {
    const graph = await loadGraph(automation.id)
    const trigger = [...graph.steps.values()].find((s) => s.type === "trigger")
    if (!trigger) continue
    if ((trigger.config as Record<string, unknown>)?.event_name !== input.eventName) continue

    const run = (await conn.one<AutomationRun>(
      from(automationRuns)
        .insert({
          automation_id: automation.id,
          team_id: input.teamId,
          contact_id: input.contactId,
          email: input.email,
          status: "running",
          current_step_key: trigger.key,
          context: { event: input.data, event_name: input.eventName },
        })
        .returning(...allColumns(automationRuns)),
    ))!
    await recordStep(run.id, trigger, "completed", { event: input.eventName })

    await enqueue({
      kind: "automation.resume",
      payload: { runId: run.id, fromKey: nextKey(graph, trigger.key) },
      teamId: input.teamId,
    })
    started++
  }

  // Any run parked on `wait_for_event` for this event resumes now.
  const waiting = await conn.all<AutomationRun>(
    from(automationRuns).where((q) => [
      q("team_id").equals(input.teamId),
      q("status").equals("waiting"),
      q("waiting_for_event").equals(input.eventName),
    ]),
  )
  for (const run of waiting) {
    if (input.contactId && run.contact_id && run.contact_id !== input.contactId) continue
    const graph = await loadGraph(run.automation_id)
    const merged = { ...(run.context ?? {}), event: input.data, event_name: input.eventName }
    await conn.execute(
      from(automationRuns)
        .where((q) => q("id").equals(run.id))
        .update({ status: "running", waiting_for_event: null, context: merged }),
    )
    await enqueue({
      kind: "automation.resume",
      payload: { runId: run.id, fromKey: nextKey(graph, run.current_step_key ?? "") },
      teamId: input.teamId,
    })
  }

  return started
}

/**
 * Walks the graph from `fromKey` until it completes, hits a delay, or parks on
 * an event. Delays and event waits suspend the run rather than blocking a worker.
 */
export const resumeAutomation = async (
  runId: string,
  fromKey: string | null,
): Promise<{ status: string; detail: string }> => {
  const conn = db()
  const run = await conn.one<AutomationRun>(
    from(automationRuns).where((q) => q("id").equals(runId)),
  )
  if (!run) return { status: "gone", detail: "run no longer exists" }
  if (run.status === "completed" || run.status === "canceled") {
    return { status: run.status, detail: "already finished" }
  }

  const graph = await loadGraph(run.automation_id)
  let context = { ...(run.context ?? {}) } as Record<string, unknown>

  let contact: Contact | null = run.contact_id
    ? await conn.one<Contact>(from(contacts).where((q) => q("id").equals(run.contact_id!)))
    : null
  if (contact) context = { ...context, ...contactContext(contact) }

  let key: string | null = fromKey
  let guard = 0

  while (key) {
    if (guard++ > 200) {
      await finish(run.id, "failed", "step limit exceeded — the graph may contain a cycle")
      return { status: "failed", detail: "step limit exceeded" }
    }

    const step: AutomationStep | undefined = graph.steps.get(key)
    if (!step) {
      await finish(run.id, "completed")
      return { status: "completed", detail: "no further steps" }
    }

    const cfg = (step.config ?? {}) as Record<string, unknown>
    await conn.execute(
      from(automationRuns)
        .where((q) => q("id").equals(run.id))
        .update({ current_step_key: step.key }),
    )

    try {
      switch (step.type) {
        case "condition": {
          const met = evaluate(cfg as Rule, context)
          await recordStep(run.id, step, "completed", { met })
          key = nextKey(graph, step.key, met ? "condition_met" : "condition_not_met")
          continue
        }

        case "delay": {
          const seconds = delaySeconds(cfg)
          const resumeAt = new Date(Date.now() + seconds * 1000)
          await recordStep(run.id, step, "completed", { resume_at: resumeAt.toISOString() })
          await conn.execute(
            from(automationRuns)
              .where((q) => q("id").equals(run.id))
              .update({ status: "waiting", resume_at: resumeAt, context }),
          )
          await enqueue({
            kind: "automation.resume",
            payload: { runId: run.id, fromKey: nextKey(graph, step.key) },
            teamId: run.team_id,
            runAt: resumeAt,
          })
          return { status: "waiting", detail: `delayed ${seconds}s` }
        }

        case "wait_for_event": {
          const eventName = String(cfg.event_name ?? "")
          const timeout = delaySeconds(cfg)
          await recordStep(run.id, step, "completed", { waiting_for: eventName })
          await conn.execute(
            from(automationRuns)
              .where((q) => q("id").equals(run.id))
              .update({
                status: "waiting",
                waiting_for_event: eventName,
                resume_at: timeout > 0 ? new Date(Date.now() + timeout * 1000) : null,
                context,
              }),
          )
          return { status: "waiting", detail: `waiting for ${eventName}` }
        }

        case "send_email": {
          const to = (run.email ?? contact?.email) as string | undefined
          if (!to) {
            await recordStep(run.id, step, "skipped", undefined, "no recipient on this run")
            key = nextKey(graph, step.key)
            continue
          }
          const email = await createEmail(
            {
              from: cfg.from ? String(cfg.from) : undefined,
              to,
              subject: cfg.subject ? render(String(cfg.subject), context) : undefined,
              html: cfg.html ? render(String(cfg.html), context) : null,
              text: cfg.text ? render(String(cfg.text), context) : null,
              topic_id: cfg.topic_id ? String(cfg.topic_id) : undefined,
              ...(cfg.template_id
                ? {
                    template: {
                      id: String(cfg.template_id),
                      variables: { ...context, ...((cfg.variables as object) ?? {}) },
                    },
                  }
                : {}),
            },
            {
              teamId: run.team_id,
              automationRunId: run.id,
              contactId: contact?.id ?? null,
            },
          )
          await recordStep(run.id, step, "completed", { email_id: email.id })
          key = nextKey(graph, step.key)
          continue
        }

        case "add_to_segment": {
          if (contact && cfg.segment_id) {
            await conn.execute({
              text: `INSERT INTO segment_contacts (segment_id, contact_id) VALUES ($1, $2)
                     ON CONFLICT (segment_id, contact_id) DO NOTHING`,
              values: [String(cfg.segment_id), contact.id],
            })
            await recordStep(run.id, step, "completed", { segment_id: cfg.segment_id })
          } else {
            await recordStep(run.id, step, "skipped", undefined, "no contact or segment_id")
          }
          key = nextKey(graph, step.key)
          continue
        }

        case "contact_update": {
          if (contact) {
            const patch: Record<string, unknown> = { updated_at: new Date() }
            if (cfg.first_name !== undefined)
              patch.first_name = render(String(cfg.first_name), context)
            if (cfg.last_name !== undefined)
              patch.last_name = render(String(cfg.last_name), context)
            if (cfg.unsubscribed !== undefined) patch.unsubscribed = Boolean(cfg.unsubscribed)
            await conn.execute(
              from(contacts)
                .where((q) => q("id").equals(contact!.id))
                .update(patch),
            )
            contact = await conn.one<Contact>(
              from(contacts).where((q) => q("id").equals(contact!.id)),
            )
            if (contact) context = { ...context, ...contactContext(contact) }
            await recordStep(run.id, step, "completed")
          } else {
            await recordStep(run.id, step, "skipped", undefined, "no contact on this run")
          }
          key = nextKey(graph, step.key)
          continue
        }

        case "contact_delete": {
          if (contact) {
            await conn.execute(
              from(contacts)
                .where((q) => q("id").equals(contact!.id))
                .del(),
            )
            await recordStep(run.id, step, "completed")
            contact = null
          } else {
            await recordStep(run.id, step, "skipped", undefined, "no contact on this run")
          }
          key = nextKey(graph, step.key)
          continue
        }

        case "trigger":
          key = nextKey(graph, step.key)
          continue

        default:
          await recordStep(run.id, step, "skipped", undefined, `unknown step type ${step.type}`)
          key = nextKey(graph, step.key)
          continue
      }
    } catch (err) {
      const message = (err as Error).message
      await recordStep(run.id, step, "failed", undefined, message)
      await finish(run.id, "failed", message)
      return { status: "failed", detail: message }
    }
  }

  await finish(run.id, "completed")
  return { status: "completed", detail: "reached the end of the graph" }
}
