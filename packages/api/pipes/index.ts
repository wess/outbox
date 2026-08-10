import { config } from "@outbox/config"
import {
  applicationError,
  authenticate,
  errorBody,
  invalidUserAgent,
  type Principal,
  rateLimitExceeded,
  requireFullAccess,
} from "@outbox/core"
import { db } from "@outbox/core/db"
import { apiLogs } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { clientIp, createDbRateLimit, parseTrustedProxies } from "@wess/atlas/security"
import { assign, type Conn, isHttpError, json, type PipeFn, type Route } from "@wess/atlas/server"

const trustedProxies = parseTrustedProxies(config.trustedProxies)

export const ipOf = (conn: Conn): string => clientIp(conn.request, { trustedProxies }) ?? "unknown"

// ------------------------------------------------------------------ errors --

// Constraint violations are caller errors, not server faults. Without this they
// would surface as 500s, which is both wrong and unhelpful to the client.
const fromPostgres = (err: unknown): { status: number; name: string; message: string } | null => {
  const e = err as { errno?: string; code?: string; detail?: string; constraint?: string }
  const sqlstate = e?.errno ?? e?.code
  const subject = e?.constraint ? ` (${e.constraint})` : ""
  switch (sqlstate) {
    case "23505":
      return {
        status: 409,
        name: "invalid_parameter",
        message: `A record with these values already exists${subject}.`,
      }
    case "23503":
      return {
        status: 422,
        name: "invalid_parameter",
        message: "A referenced record does not exist.",
      }
    case "23502":
      return {
        status: 422,
        name: "missing_required_field",
        message: "A required field is missing.",
      }
    case "22P02":
    case "22001":
      return {
        status: 400,
        name: "invalid_parameter",
        message: "A parameter has an invalid value.",
      }
    default:
      return null
  }
}

export const renderError = (conn: Conn, err: unknown): Conn => {
  if (isHttpError(err)) {
    let next = json(conn, err.status, errorBody(err))
    for (const [k, v] of Object.entries(err.headers ?? {})) {
      next = { ...next, respHeaders: new Headers([...next.respHeaders, [k, v]]) }
    }
    return next
  }
  // Atlas's typed `route()` raises this when a zod schema rejects the input.
  const maybe = err as { status?: number; code?: string; details?: unknown; message?: string }
  if (maybe?.code === "VALIDATION_FAILED") {
    return json(conn, 422, {
      statusCode: 422,
      name: "validation_error",
      message: maybe.message ?? "Invalid request payload.",
    })
  }
  const pg = fromPostgres(err)
  if (pg)
    return json(conn, pg.status, { statusCode: pg.status, name: pg.name, message: pg.message })

  console.error("[outbox] unhandled route error:", err)
  return json(conn, 500, errorBody(applicationError()))
}

// --------------------------------------------------------------- api logs --

const LOGGED_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE", "GET"])

const recordLog = async (input: {
  conn: Conn
  status: number
  teamId: string | null
  apiKeyId: string | null
  requestBody: unknown
  responseBody: unknown
  durationMs: number
}): Promise<void> => {
  try {
    await db().execute(
      from(apiLogs).insert({
        team_id: input.teamId,
        api_key_id: input.apiKeyId,
        endpoint: input.conn.path,
        method: input.conn.method,
        response_status: input.status,
        user_agent: input.conn.headers.get("user-agent"),
        ip: ipOf(input.conn),
        request_body: (input.requestBody ?? null) as never,
        response_body: (input.responseBody ?? null) as never,
        duration_ms: input.durationMs,
      }),
    )
  } catch (e) {
    console.error("[outbox] failed to write api log:", e)
  }
}

// ------------------------------------------------------------------- pipes --

// Resend rejects API calls with no User-Agent (error 1010). Matching that keeps
// SDK behaviour identical across both services.
export const requireUserAgent: PipeFn = (conn) => {
  const ua = conn.headers.get("user-agent")
  if (!ua || ua.trim() === "") throw invalidUserAgent()
  return conn
}

export const apiAuth: PipeFn = async (conn) => {
  const auth = await authenticate({
    authorization: conn.headers.get("authorization"),
    cookie: conn.headers.get("cookie"),
  })
  return assign(conn, { auth })
}

// Send endpoints accept sending_access keys; everything else needs full access.
export const fullAccess: PipeFn = (conn) => {
  requireFullAccess(conn.assigns.auth as Principal)
  return conn
}

const limiter = createDbRateLimit({ db: db() })

export const rateLimit: PipeFn = async (conn) => {
  const auth = conn.assigns.auth as Principal | undefined
  const bucket = auth ? `api:team:${auth.teamId}` : `api:ip:${ipOf(conn)}`
  const { ok, retryAfterSeconds } = await limiter.check(bucket, config.rateLimitPerSecond, 1)
  if (!ok) throw rateLimitExceeded(retryAfterSeconds ?? 1, config.rateLimitPerSecond)
  return conn
}

export const authed: readonly PipeFn[] = [requireUserAgent, apiAuth, rateLimit]
export const authedFull: readonly PipeFn[] = [requireUserAgent, apiAuth, rateLimit, fullAccess]

export const authOf = (conn: { assigns: unknown }): Principal =>
  (conn.assigns as { auth: Principal }).auth

// ---------------------------------------------------------------- wrapping --

export type WrapOptions = { log?: boolean }

/**
 * Wraps a route handler so thrown errors render in Resend's envelope and every
 * API call lands in the logs table. The router's own catch never fires because
 * we resolve the error into a Conn here.
 */
export const wrap = (handler: PipeFn, opts: WrapOptions = {}): PipeFn => {
  const shouldLog = opts.log !== false
  return async (conn) => {
    const started = performance.now()
    // Clone up front: the handler consumes the stream when it parses the body.
    const clone = shouldLog && LOGGED_METHODS.has(conn.method) ? conn.request.clone() : null

    let result: Conn
    try {
      result = await handler(conn)
    } catch (err) {
      result = renderError(conn, err)
    }

    if (shouldLog) {
      const auth = result.assigns?.auth as Principal | undefined
      let requestBody: unknown = null
      if (clone) {
        try {
          const text = await clone.text()
          requestBody = text ? JSON.parse(text) : null
        } catch {
          requestBody = null
        }
      }
      void recordLog({
        conn,
        status: result.status,
        teamId: auth?.teamId ?? null,
        apiKeyId: auth?.apiKeyId ?? null,
        requestBody,
        responseBody: typeof result.body === "object" ? result.body : null,
        durationMs: Math.round(performance.now() - started),
      })
    }

    return result
  }
}

export const wrapAll = (routes: readonly Route[], opts: WrapOptions = {}): Route[] =>
  routes.map((r) => ({ ...r, handler: wrap(r.handler, opts) }))
