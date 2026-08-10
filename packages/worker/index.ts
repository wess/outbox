import { randomUUID } from "node:crypto"
import { config } from "@outbox/config"
import { claim, complete, enqueue, fail, reclaimStale, verifyDomain } from "@outbox/core"
import { db } from "@outbox/core/db"
import { automationRuns, type Domain, domains, type Job } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { resumeAutomation, startAutomations } from "./automation/index.ts"
import { fanOutBroadcast } from "./broadcast/index.ts"
import { deliverEmail } from "./send/index.ts"
import { deliverWebhookEvent } from "./webhook/index.ts"

export * from "./automation/index.ts"
export * from "./broadcast/index.ts"
export * from "./send/index.ts"
export * from "./webhook/index.ts"

const num = (v: unknown): string | null => (typeof v === "string" ? v : null)

const runJob = async (job: Job): Promise<string> => {
  const payload = job.payload ?? {}

  switch (job.kind) {
    case "email.send": {
      const emailId = num(payload.emailId)
      if (!emailId) return "missing emailId"
      const result = await deliverEmail(emailId)
      return `${result.status}: ${result.detail}`
    }

    case "broadcast.fanout": {
      const broadcastId = num(payload.broadcastId)
      if (!broadcastId) return "missing broadcastId"
      const result = await fanOutBroadcast(broadcastId)
      return `queued ${result.queued}, skipped ${result.skipped}`
    }

    case "webhook.deliver": {
      const eventId = num(payload.eventId)
      if (!eventId) return "missing eventId"
      const result = await deliverWebhookEvent(eventId)
      // The event row already carries its own next_attempt_at, so the retry is
      // scheduled here rather than by failing the job.
      if (result.status === "retrying") {
        const row = await db().one<{ next_attempt_at: Date | null }>({
          text: "SELECT next_attempt_at FROM webhook_events WHERE id = $1",
          values: [eventId],
        })
        await enqueue({
          kind: "webhook.deliver",
          payload: { eventId },
          teamId: job.team_id,
          runAt: row?.next_attempt_at ?? new Date(Date.now() + 60_000),
        })
      }
      return `${result.status}: ${result.detail}`
    }

    case "automation.start": {
      const started = await startAutomations({
        teamId: job.team_id!,
        eventName: String(payload.eventName ?? ""),
        email: num(payload.email),
        contactId: num(payload.contactId),
        data: (payload.data as Record<string, unknown>) ?? {},
      })
      return `started ${started} automation run(s)`
    }

    case "automation.resume": {
      const runId = num(payload.runId)
      if (!runId) return "missing runId"
      const result = await resumeAutomation(runId, num(payload.fromKey))
      return `${result.status}: ${result.detail}`
    }

    case "domain.verify": {
      const domainId = num(payload.domainId)
      if (!domainId) return "missing domainId"
      const domain = await db().one<Domain>(from(domains).where((q) => q("id").equals(domainId)))
      if (!domain) return "domain no longer exists"
      const result = await verifyDomain(domain)
      return `status ${result.domain.status}`
    }

    default:
      return `unknown job kind: ${job.kind}`
  }
}

export type Worker = { stop: () => Promise<void> }

/**
 * Polls the jobs table and runs due work. Many workers can run at once — the
 * claim uses SELECT ... FOR UPDATE SKIP LOCKED so they never collide.
 */
export const startWorker = async (): Promise<Worker> => {
  const workerId = `${Bun.env.HOSTNAME ?? "worker"}-${randomUUID().slice(0, 8)}`
  const concurrency = config.worker.concurrency
  const pollMs = config.worker.pollMs
  let running = true
  let inFlight = 0

  console.log(
    `[outbox] worker ${workerId} started (concurrency ${concurrency}, transport ${config.transport})`,
  )

  // Delivering straight to MX means most failures come back later as a DSN to
  // the return path. With no inbound server listening, those are never seen and
  // the suppression list only ever learns about synchronous rejections.
  if (config.transport === "smtp" && !config.inbound.enabled) {
    console.warn(
      "[outbox] transport is `smtp` but INBOUND_ENABLED is false — bounces sent to the return path will not be processed, so dead addresses will not be suppressed",
    )
  }

  const process = async (job: Job) => {
    inFlight++
    try {
      const detail = await runJob(job)
      await complete(job.id)
      console.log(`[outbox] ${job.kind} ${job.id.slice(0, 8)} — ${detail}`)
    } catch (err) {
      const message = (err as Error).message
      await fail(job, message)
      console.warn(
        `[outbox] ${job.kind} ${job.id.slice(0, 8)} failed (attempt ${job.attempts}/${job.max_attempts}): ${message}`,
      )
    } finally {
      inFlight--
    }
  }

  // Runs parked on a delay wake up here when their resume_at passes.
  const sweepWaitingRuns = async () => {
    const due = await db().all<{ id: string; team_id: string }>({
      text: `SELECT id, team_id FROM automation_runs
             WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= now()
               AND waiting_for_event IS NOT NULL
             LIMIT 50`,
      values: [],
    })
    for (const run of due) {
      // A wait_for_event that timed out ends the run rather than continuing.
      await db().execute(
        from(automationRuns)
          .where((q) => q("id").equals(run.id))
          .update({
            status: "completed",
            completed_at: new Date(),
            resume_at: null,
            waiting_for_event: null,
            error: "timed out waiting for event",
          }),
      )
    }
  }

  let ticks = 0
  const loop = async () => {
    while (running) {
      try {
        const capacity = concurrency - inFlight
        if (capacity > 0) {
          const jobs = await claim(workerId, capacity)
          for (const job of jobs) void process(job)
          if (jobs.length === capacity) continue
        }
        // Housekeeping every ~30 polls: recover crashed workers, expire waits.
        if (++ticks % 30 === 0) {
          const reclaimed = await reclaimStale()
          if (reclaimed > 0) console.log(`[outbox] reclaimed ${reclaimed} stale job(s)`)
          await sweepWaitingRuns()
        }
      } catch (err) {
        console.error("[outbox] worker loop error:", (err as Error).message)
      }
      await Bun.sleep(pollMs)
    }
  }

  void loop()

  return {
    stop: async () => {
      running = false
      // Let in-flight jobs finish before the process exits.
      for (let i = 0; i < 100 && inFlight > 0; i++) await Bun.sleep(100)
    },
  }
}
