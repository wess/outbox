/**
 * Outbox client.
 *
 * The method surface mirrors `resend-node`, so porting is a one-line change.
 * Keys are accepted in camelCase or snake_case and sent as snake_case.
 */

export type ClientOptions = {
  apiKey: string
  baseUrl?: string
  userAgent?: string
  fetch?: typeof fetch
}

export type Result<T> = { data: T; error: null } | { data: null; error: OutboxError }

export type OutboxError = { statusCode: number; name: string; message: string }

const SNAKE_EXCEPTIONS = new Set(["headers", "variables", "properties", "data"])

const toSnake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

// Recursively rewrite keys, leaving free-form maps (headers, variables) alone.
const snakeify = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(snakeify)
  if (value === null || typeof value !== "object") return value
  if (value instanceof Uint8Array) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = toSnake(key)
    out[next] = SNAKE_EXCEPTIONS.has(next) ? item : snakeify(item)
  }
  return out
}

export type Client = ReturnType<typeof createClient>

export const createClient = (options: ClientOptions) => {
  const baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/$/, "")
  const userAgent = options.userAgent ?? "outbox-node/0.1.0"
  const doFetch = options.fetch ?? globalThis.fetch

  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Result<T>> => {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "user-agent": userAgent,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(snakeify(body)) } : {}),
    })

    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    if (!res.ok) {
      const err = parsed as OutboxError
      return {
        data: null,
        error: err?.message
          ? err
          : {
              statusCode: res.status,
              name: "application_error",
              message: `Request failed (${res.status})`,
            },
      }
    }
    return { data: parsed as T, error: null }
  }

  const query = (params: Record<string, unknown> = {}): string => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue
      search.set(toSnake(key), String(value))
    }
    const s = search.toString()
    return s ? `?${s}` : ""
  }

  return {
    emails: {
      send: (payload: Record<string, unknown>, opts: { idempotencyKey?: string } = {}) =>
        call<{ id: string }>(
          "POST",
          "/emails",
          payload,
          opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {},
        ),
      get: (id: string) => call<Record<string, unknown>>("GET", `/emails/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/emails${query(params)}`),
      update: (payload: { id: string; scheduledAt?: string; scheduled_at?: string }) =>
        call<{ id: string }>("PATCH", `/emails/${payload.id}`, {
          scheduled_at: payload.scheduledAt ?? payload.scheduled_at,
        }),
      cancel: (id: string) => call<{ id: string }>("POST", `/emails/${id}/cancel`),
      attachments: {
        list: (emailId: string) =>
          call<Record<string, unknown>>("GET", `/emails/${emailId}/attachments`),
        get: (emailId: string, id: string) =>
          call<Record<string, unknown>>("GET", `/emails/${emailId}/attachments/${id}`),
      },
      metrics: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/emails/metrics${query(params)}`),
      received: {
        list: (params?: Record<string, unknown>) =>
          call<Record<string, unknown>>("GET", `/emails/receiving${query(params)}`),
        get: (id: string) => call<Record<string, unknown>>("GET", `/emails/receiving/${id}`),
      },
    },

    batch: {
      send: (payloads: Record<string, unknown>[], opts: { idempotencyKey?: string } = {}) =>
        call<{ data: { id: string }[] }>(
          "POST",
          "/emails/batch",
          payloads,
          opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {},
        ),
    },

    domains: {
      create: (payload: Record<string, unknown>) =>
        call<Record<string, unknown>>("POST", "/domains", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/domains/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/domains${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/domains/${id}`, rest)
      },
      verify: (id: string) => call<Record<string, unknown>>("POST", `/domains/${id}/verify`),
      remove: (id: string) => call<{ id: string }>("DELETE", `/domains/${id}`),
    },

    apiKeys: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string; token: string }>("POST", "/api-keys", payload),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/api-keys${query(params)}`),
      remove: (id: string) => call<Record<string, unknown>>("DELETE", `/api-keys/${id}`),
    },

    segments: {
      create: (payload: { name: string }) =>
        call<Record<string, unknown>>("POST", "/segments", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/segments/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/segments${query(params)}`),
      remove: (id: string) => call<{ id: string }>("DELETE", `/segments/${id}`),
      contacts: (id: string, params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/segments/${id}/contacts${query(params)}`),
      metrics: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/segments/metrics${query(params)}`),
    },

    // Audiences is the previous name for segments; both paths are mounted.
    audiences: {
      create: (payload: { name: string }) =>
        call<Record<string, unknown>>("POST", "/audiences", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/audiences/${id}`),
      list: () => call<Record<string, unknown>>("GET", "/audiences"),
      remove: (id: string) => call<{ id: string }>("DELETE", `/audiences/${id}`),
    },

    contacts: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string }>("POST", "/contacts", payload),
      get: (idOrEmail: string) => call<Record<string, unknown>>("GET", `/contacts/${idOrEmail}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/contacts${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/contacts/${id}`, rest)
      },
      remove: (idOrEmail: string) => call<{ id: string }>("DELETE", `/contacts/${idOrEmail}`),
      topics: {
        list: (idOrEmail: string) =>
          call<Record<string, unknown>>("GET", `/contacts/${idOrEmail}/topics`),
        update: (idOrEmail: string, topics: { id: string; subscription: string }[]) =>
          call<{ id: string }>("PATCH", `/contacts/${idOrEmail}/topics`, { topics }),
      },
      segments: {
        list: (idOrEmail: string) =>
          call<Record<string, unknown>>("GET", `/contacts/${idOrEmail}/segments`),
        add: (idOrEmail: string, segmentId: string) =>
          call<Record<string, unknown>>("POST", `/contacts/${idOrEmail}/segments/${segmentId}`),
        remove: (idOrEmail: string, segmentId: string) =>
          call<Record<string, unknown>>("DELETE", `/contacts/${idOrEmail}/segments/${segmentId}`),
      },
    },

    contactProperties: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string }>("POST", "/contact-properties", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/contact-properties/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/contact-properties${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/contact-properties/${id}`, rest)
      },
      remove: (id: string) => call<{ id: string }>("DELETE", `/contact-properties/${id}`),
    },

    topics: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string }>("POST", "/topics", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/topics/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/topics${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/topics/${id}`, rest)
      },
      remove: (id: string) => call<{ id: string }>("DELETE", `/topics/${id}`),
    },

    broadcasts: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string }>("POST", "/broadcasts", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/broadcasts/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/broadcasts${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/broadcasts/${id}`, rest)
      },
      send: (id: string, payload: { scheduledAt?: string } = {}) =>
        call<{ id: string }>("POST", `/broadcasts/${id}/send`, payload),
      remove: (id: string) => call<{ id: string }>("DELETE", `/broadcasts/${id}`),
      metrics: (id: string) => call<Record<string, unknown>>("GET", `/broadcasts/${id}/metrics`),
      recipients: (id: string, params: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/broadcasts/${id}/recipients${query(params)}`),
    },

    templates: {
      create: (payload: Record<string, unknown>) =>
        call<{ id: string }>("POST", "/templates", payload),
      get: (idOrAlias: string) => call<Record<string, unknown>>("GET", `/templates/${idOrAlias}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/templates${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/templates/${id}`, rest)
      },
      publish: (idOrAlias: string) =>
        call<{ id: string }>("POST", `/templates/${idOrAlias}/publish`),
      duplicate: (idOrAlias: string) =>
        call<{ id: string }>("POST", `/templates/${idOrAlias}/duplicate`),
      remove: (idOrAlias: string) => call<{ id: string }>("DELETE", `/templates/${idOrAlias}`),
    },

    suppressions: {
      add: (payload: { email: string }) => call<{ id: string }>("POST", "/suppressions", payload),
      get: (idOrEmail: string) =>
        call<Record<string, unknown>>("GET", `/suppressions/${idOrEmail}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/suppressions${query(params)}`),
      remove: (idOrEmail: string) => call<{ id: string }>("DELETE", `/suppressions/${idOrEmail}`),
      batch: {
        add: (emails: string[]) =>
          call<Record<string, unknown>>("POST", "/suppressions/batch/add", { emails }),
        remove: (payload: { emails?: string[]; ids?: string[] }) =>
          call<Record<string, unknown>>("POST", "/suppressions/batch/remove", payload),
      },
    },

    webhooks: {
      create: (payload: { endpoint: string; events: string[] }) =>
        call<Record<string, unknown>>("POST", "/webhooks", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/webhooks/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/webhooks${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<{ id: string }>("PATCH", `/webhooks/${id}`, rest)
      },
      remove: (id: string) => call<{ id: string }>("DELETE", `/webhooks/${id}`),
      events: {
        list: (webhookId: string, params?: Record<string, unknown>) =>
          call<Record<string, unknown>>("GET", `/webhooks/${webhookId}/events${query(params)}`),
        get: (webhookId: string, eventId: string) =>
          call<Record<string, unknown>>("GET", `/webhooks/${webhookId}/events/${eventId}`),
        attempts: (webhookId: string, eventId: string) =>
          call<Record<string, unknown>>("GET", `/webhooks/${webhookId}/events/${eventId}/attempts`),
      },
      verify: verifyWebhook,
    },

    automations: {
      create: (payload: Record<string, unknown>) =>
        call<Record<string, unknown>>("POST", "/automations", payload),
      get: (id: string) => call<Record<string, unknown>>("GET", `/automations/${id}`),
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/automations${query(params)}`),
      update: (payload: { id: string } & Record<string, unknown>) => {
        const { id, ...rest } = payload
        return call<Record<string, unknown>>("PATCH", `/automations/${id}`, rest)
      },
      remove: (id: string) => call<{ id: string }>("DELETE", `/automations/${id}`),
      runs: (id: string, params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/automations/${id}/runs${query(params)}`),
      run: (id: string, runId: string) =>
        call<Record<string, unknown>>("GET", `/automations/${id}/runs/${runId}`),
    },

    events: {
      send: (payload: {
        name: string
        email?: string
        contactId?: string
        data?: Record<string, unknown>
      }) => call<{ id: string }>("POST", "/events/send", payload),
    },

    logs: {
      list: (params?: Record<string, unknown>) =>
        call<Record<string, unknown>>("GET", `/logs${query(params)}`),
      get: (id: string) => call<Record<string, unknown>>("GET", `/logs/${id}`),
    },
  }
}

// ------------------------------------------------------------- webhooks --

/**
 * Verifies a webhook request. Outbox signs with the Svix scheme, so the same
 * call works against Resend-signed payloads too.
 *
 * `payload` must be the raw request body — re-serialising parsed JSON changes
 * the bytes and the signature will not match.
 */
export const verifyWebhook = async (input: {
  payload: string
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
  webhookSecret: string
  toleranceSeconds?: number
}): Promise<Record<string, unknown>> => {
  const { id, timestamp, signature } = input.headers
  if (!id || !timestamp || !signature) throw new Error("Missing webhook signature headers")

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) throw new Error("Invalid webhook timestamp")
  const tolerance = input.toleranceSeconds ?? 300
  if (Math.abs(Date.now() / 1000 - ts) > tolerance)
    throw new Error("Webhook timestamp outside tolerance")

  const key = Uint8Array.from(atob(input.webhookSecret.replace(/^whsec_/, "")), (c) =>
    c.charCodeAt(0),
  )
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${id}.${ts}.${input.payload}`),
  )
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))

  const matched = signature.split(" ").some((part) => {
    const [version, sig] = part.split(",")
    if (version !== "v1" || !sig || sig.length !== expected.length) return false
    // Constant-time compare so a mismatch does not leak position.
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  })
  if (!matched) throw new Error("Webhook signature does not match")

  return JSON.parse(input.payload) as Record<string, unknown>
}

export default createClient
