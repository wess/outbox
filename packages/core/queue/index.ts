import { type Job, jobs } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { allColumns, db } from "../db/index.ts"

export type JobKind =
  | "email.send"
  | "broadcast.fanout"
  | "webhook.deliver"
  | "automation.resume"
  | "automation.start"
  | "domain.verify"

export const enqueue = async (input: {
  kind: JobKind
  payload: Record<string, unknown>
  teamId?: string | null
  runAt?: Date
  maxAttempts?: number
}): Promise<Job> => {
  const row = await db().one<Job>(
    from(jobs)
      .insert({
        kind: input.kind,
        payload: input.payload,
        team_id: input.teamId ?? null,
        run_at: input.runAt ?? new Date(),
        max_attempts: input.maxAttempts ?? 5,
      })
      .returning(...allColumns(jobs)),
  )
  return row!
}

/**
 * Claims up to `limit` due jobs atomically. SKIP LOCKED lets many workers poll
 * the same table without contending, and the UPDATE ... RETURNING keeps the
 * claim in one round trip.
 */
export const claim = async (workerId: string, limit: number): Promise<Job[]> =>
  db().all<Job>({
    text: `
      UPDATE jobs SET
        status = 'running',
        locked_at = now(),
        locked_by = $1,
        attempts = attempts + 1,
        updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'pending' AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      RETURNING *`,
    values: [workerId, limit],
  })

export const complete = async (id: string): Promise<void> => {
  await db().execute({
    text: "UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = now() WHERE id = $1",
    values: [id],
  })
}

// Exponential backoff, capped at 10 minutes, until max_attempts is spent.
export const fail = async (job: Job, error: string): Promise<void> => {
  const exhausted = job.attempts >= job.max_attempts
  const delaySeconds = Math.min(600, 2 ** job.attempts)
  await db().execute({
    text: `
      UPDATE jobs SET
        status = $2,
        run_at = now() + ($3 || ' seconds')::interval,
        locked_at = NULL,
        locked_by = NULL,
        last_error = $4,
        updated_at = now()
      WHERE id = $1`,
    values: [job.id, exhausted ? "failed" : "pending", String(delaySeconds), error.slice(0, 2000)],
  })
}

// Releases jobs whose worker died mid-flight.
export const reclaimStale = async (olderThanSeconds = 300): Promise<number> => {
  const rows = await db().all<{ id: string }>({
    text: `
      UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL
      WHERE status = 'running' AND locked_at < now() - ($1 || ' seconds')::interval
      RETURNING id`,
    values: [String(olderThanSeconds)],
  })
  return rows.length
}
