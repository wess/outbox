import { createHash } from "node:crypto"
import { type IdempotencyKey, idempotencyKeys } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { db } from "../db/index.ts"
import {
  concurrentIdempotentRequests,
  invalidIdempotencyKey,
  invalidIdempotentRequest,
} from "../errors/index.ts"

const TTL_HOURS = 24
const MIN_LENGTH = 1
const MAX_LENGTH = 256

export const hashRequest = (body: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")

export type IdempotencyHit =
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "proceed"; commit: (status: number, body: unknown) => Promise<void> }

/**
 * Claims an idempotency key for this request.
 *
 * A repeat of a completed request replays the stored response. A repeat that
 * arrives while the original is still running gets 409, and a repeat with a
 * different payload gets 400 — both per Resend's documented behaviour.
 */
export const claimIdempotency = async (
  teamId: string,
  key: string,
  requestBody: unknown,
): Promise<IdempotencyHit> => {
  if (key.length < MIN_LENGTH || key.length > MAX_LENGTH) {
    throw invalidIdempotencyKey(
      `\`Idempotency-Key\` must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`,
    )
  }

  const conn = db()
  const hash = hashRequest(requestBody)
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600_000)

  // Drop expired rows so a key can be reused after its window.
  await conn.execute({
    text: "DELETE FROM idempotency_keys WHERE team_id = $1 AND key = $2 AND expires_at < now()",
    values: [teamId, key],
  })

  const claimed = await conn.all<IdempotencyKey>({
    text: `INSERT INTO idempotency_keys (team_id, key, request_hash, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id, key) DO NOTHING
           RETURNING *`,
    values: [teamId, key, hash, expiresAt],
  })

  if (claimed.length === 0) {
    const existing = await conn.one<IdempotencyKey>(
      from(idempotencyKeys).where((q) => [q("team_id").equals(teamId), q("key").equals(key)]),
    )
    if (!existing) throw concurrentIdempotentRequests()
    if (existing.request_hash !== hash) throw invalidIdempotentRequest()
    if (existing.response_status === null) throw concurrentIdempotentRequests()
    return { kind: "replay", status: existing.response_status, body: existing.response_body }
  }

  const row = claimed[0]!
  return {
    kind: "proceed",
    commit: async (status: number, body: unknown) => {
      await conn.execute(
        from(idempotencyKeys)
          .where((q) => q("id").equals(row.id))
          .update({ response_status: status, response_body: body as never }),
      )
    },
  }
}

// A failed request must not pin the key — release it so the caller can retry.
export const releaseIdempotency = async (teamId: string, key: string): Promise<void> => {
  await db().execute({
    text: "DELETE FROM idempotency_keys WHERE team_id = $1 AND key = $2 AND response_status IS NULL",
    values: [teamId, key],
  })
}
