import { type Integration, integrations } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { decodeConnection, INKLING_PREFIX, type ServiceConnection } from "../connect/index.ts"
import { allColumns, db } from "../db/index.ts"
import { invalidParameter, notFound } from "../errors/index.ts"
import { createInklingClient, type InklingClient } from "../inkling/index.ts"

export const PROVIDERS = ["inkling"] as const
export type Provider = (typeof PROVIDERS)[number]

const PREFIX_FOR: Record<Provider, string> = { inkling: INKLING_PREFIX }

export const isProvider = (value: string): value is Provider =>
  (PROVIDERS as readonly string[]).includes(value)

export const findIntegration = async (
  teamId: string,
  provider: Provider,
): Promise<Integration | null> =>
  db().one<Integration>(
    from(integrations).where((q) => [q("team_id").equals(teamId), q("provider").equals(provider)]),
  )

export const requireIntegration = async (
  teamId: string,
  provider: Provider,
): Promise<Integration> => {
  const row = await findIntegration(teamId, provider)
  if (!row) {
    throw notFound(
      `No ${provider} connection. Paste a connection token at /app/integrations first.`,
    )
  }
  return row
}

export const inklingFor = async (teamId: string): Promise<InklingClient> => {
  const row = await requireIntegration(teamId, "inkling")
  return createInklingClient({ baseUrl: row.base_url, apiKey: row.api_key })
}

/** Confirms the credential actually works before it is stored. */
const probe = async (
  provider: Provider,
  connection: ServiceConnection,
): Promise<{ detail: string }> => {
  if (provider === "inkling") {
    const client = createInklingClient({ baseUrl: connection.url, apiKey: connection.key })
    const types = await client.types()
    return {
      detail:
        types.length === 0
          ? "connected, but this key can read no content types"
          : `${types.length} content type${types.length === 1 ? "" : "s"} readable`,
    }
  }
  return { detail: "connected" }
}

export type ConnectResult = { integration: Integration; detail: string }

/**
 * Pairs this team with another service from a single pasted token.
 *
 * The credential is verified before it is written, so a typo fails here with a
 * usable message rather than silently at the first send.
 */
export const connectIntegration = async (input: {
  teamId: string
  provider: Provider
  token: string
  settings?: Record<string, unknown>
}): Promise<ConnectResult> => {
  const connection = decodeConnection(input.token, PREFIX_FOR[input.provider])
  const { detail } = await probe(input.provider, connection)

  const row = await db().one<Integration>({
    text: `INSERT INTO integrations (team_id, provider, name, base_url, api_key, settings, status, last_checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', now())
           ON CONFLICT (team_id, provider) DO UPDATE SET
             name = EXCLUDED.name,
             base_url = EXCLUDED.base_url,
             api_key = EXCLUDED.api_key,
             settings = COALESCE(EXCLUDED.settings, integrations.settings),
             status = 'connected',
             last_error = NULL,
             last_checked_at = now(),
             updated_at = now()
           RETURNING *`,
    values: [
      input.teamId,
      input.provider,
      connection.name ?? null,
      connection.url,
      connection.key,
      input.settings ?? null,
    ],
  })

  return { integration: row!, detail }
}

export const updateIntegrationSettings = async (
  teamId: string,
  provider: Provider,
  settings: Record<string, unknown>,
): Promise<Integration> => {
  const existing = await requireIntegration(teamId, provider)
  const row = await db().one<Integration>(
    from(integrations)
      .where((q) => q("id").equals(existing.id))
      .update({ settings: { ...(existing.settings ?? {}), ...settings }, updated_at: new Date() })
      .returning(...allColumns(integrations)),
  )
  return row!
}

export const disconnectIntegration = async (teamId: string, provider: Provider): Promise<void> => {
  await db().execute(
    from(integrations)
      .where((q) => [q("team_id").equals(teamId), q("provider").equals(provider)])
      .del(),
  )
}

/** Re-runs the probe and records the outcome, for a status badge in the UI. */
export const checkIntegration = async (
  teamId: string,
  provider: Provider,
): Promise<{ ok: boolean; detail: string }> => {
  const row = await requireIntegration(teamId, provider)
  try {
    const { detail } = await probe(provider, { v: 1, url: row.base_url, key: row.api_key })
    await db().execute(
      from(integrations)
        .where((q) => q("id").equals(row.id))
        .update({ status: "connected", last_error: null, last_checked_at: new Date() }),
    )
    return { ok: true, detail }
  } catch (err) {
    const message = (err as Error).message
    await db().execute(
      from(integrations)
        .where((q) => q("id").equals(row.id))
        .update({ status: "error", last_error: message, last_checked_at: new Date() }),
    )
    return { ok: false, detail: message }
  }
}

// The credential never leaves the server.
export const integrationObject = (row: Integration) => ({
  object: "integration" as const,
  id: row.id,
  provider: row.provider,
  name: row.name,
  base_url: row.base_url,
  settings: row.settings ?? {},
  status: row.status,
  last_error: row.last_error,
  last_checked_at: row.last_checked_at,
  created_at: row.created_at,
})
