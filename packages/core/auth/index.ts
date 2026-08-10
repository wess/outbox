import { createHash, randomUUID } from "node:crypto"
import { config } from "@outbox/config"
import { type ApiKey, apiKeys, memberships, sessions } from "@outbox/schema"
import { token } from "@wess/atlas/auth"
import { from } from "@wess/atlas/db"
import { allColumns, db } from "../db/index.ts"
import { invalidApiKey, missingApiKey, restrictedApiKey } from "../errors/index.ts"
import { apiKeyToken, tokenPrefix } from "../ids/index.ts"

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

/**
 * Whoever is making the request. Both an API key and a dashboard session
 * resolve to one of these so every endpoint works for both callers.
 */
export type Principal = {
  teamId: string
  permission: "full_access" | "sending_access"
  apiKeyId: string | null
  userId: string | null
  domainId: string | null
}

export type IssuedApiKey = { row: ApiKey; token: string }

export const issueApiKey = async (input: {
  teamId: string
  name: string
  permission?: string
  domainId?: string | null
  createdBy?: string | null
}): Promise<IssuedApiKey> => {
  const token = apiKeyToken()
  const row = await db().one<ApiKey>(
    from(apiKeys)
      .insert({
        team_id: input.teamId,
        name: input.name,
        permission: input.permission ?? "full_access",
        domain_id: input.domainId ?? null,
        token_hash: hashToken(token),
        token_prefix: tokenPrefix(token),
        created_by: input.createdBy ?? null,
      })
      .returning(...allColumns(apiKeys)),
  )
  return { row: row!, token }
}

export const bearerToken = (header: string | null): string | null => {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? null
}

export const readCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return decodeURIComponent(rest.join("="))
  }
  return null
}

export const SESSION_COOKIE = "outbox_session"
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

export const issueSession = async (
  userId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; jti: string; expiresAt: Date }> => {
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)
  await db().execute(
    from(sessions).insert({
      id: jti,
      user_id: userId,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
      expires_at: expiresAt,
    }),
  )
  const signed = await token.sign({ sub: userId, jti }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
  })
  return { token: signed, jti, expiresAt }
}

export const revokeSession = async (jti: string): Promise<void> => {
  await db().execute(
    from(sessions)
      .where((q) => q("id").equals(jti))
      .update({ revoked_at: new Date() }),
  )
}

export type SessionUser = { userId: string; jti: string; teamId: string }

export const resolveSession = async (cookieHeader: string | null): Promise<SessionUser | null> => {
  const raw = readCookie(cookieHeader, SESSION_COOKIE)
  if (!raw) return null

  let payload: { sub?: unknown; jti?: unknown }
  try {
    payload = (await token.verify(raw, config.jwtSecret)) as typeof payload
  } catch {
    return null
  }
  const userId = typeof payload.sub === "string" ? payload.sub : null
  const jti = typeof payload.jti === "string" ? payload.jti : null
  if (!userId || !jti) return null

  const row = await db().one<{ id: string; revoked_at: Date | null; expires_at: Date }>(
    from(sessions)
      .select("id", "revoked_at", "expires_at")
      .where((q) => q("id").equals(jti)),
  )
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null

  const membership = await db().one<{ team_id: string }>(
    from(memberships)
      .select("team_id")
      .where((q) => q("user_id").equals(userId)),
  )
  if (!membership) return null

  void db()
    .execute(
      from(sessions)
        .where((q) => q("id").equals(jti))
        .update({ last_used_at: new Date() }),
    )
    .catch(() => {})

  return { userId, jti, teamId: membership.team_id }
}

/**
 * Resolves the caller from an API key first, then a dashboard session cookie.
 * The dashboard therefore reaches the same endpoints as the public API.
 */
export const authenticate = async (input: {
  authorization: string | null
  cookie: string | null
}): Promise<Principal> => {
  const bearer = bearerToken(input.authorization)

  if (bearer) {
    const key = await db().one<ApiKey>(
      from(apiKeys).where((q) => q("token_hash").equals(hashToken(bearer))),
    )
    if (!key) throw invalidApiKey()

    void db()
      .execute(
        from(apiKeys)
          .where((q) => q("id").equals(key.id))
          .update({ last_used_at: new Date() }),
      )
      .catch(() => {})

    return {
      teamId: key.team_id,
      permission: key.permission === "sending_access" ? "sending_access" : "full_access",
      apiKeyId: key.id,
      userId: key.created_by,
      domainId: key.domain_id,
    }
  }

  const session = await resolveSession(input.cookie)
  if (session) {
    return {
      teamId: session.teamId,
      permission: "full_access",
      apiKeyId: null,
      userId: session.userId,
      domainId: null,
    }
  }

  throw missingApiKey()
}

// `sending_access` keys may only call the send endpoints.
export const requireFullAccess = (principal: Principal): void => {
  if (principal.permission !== "full_access") throw restrictedApiKey()
}

// A domain-scoped key may only send from that domain.
export const assertDomainAllowed = (principal: Principal, domainId: string | null): void => {
  if (!principal.domainId) return
  if (principal.domainId !== domainId) throw invalidApiKey()
}
