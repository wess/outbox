export type ApiError = { statusCode: number; name: string; message: string }

export class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(error: ApiError) {
    super(error.message)
    this.name = "RequestError"
    this.status = error.statusCode
    this.code = error.name
  }
}

// The dashboard authenticates with the session cookie, so the same endpoints
// the public API exposes are reachable here without an API key.
export const request = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!res.ok) {
    const err = parsed as ApiError
    throw new RequestError(
      err?.message
        ? err
        : {
            statusCode: res.status,
            name: "application_error",
            message: `Request failed (${res.status})`,
          },
    )
  }
  return parsed as T
}

export const get = <T>(path: string) => request<T>(path)
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body })
export const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body })
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" })

export type List<T> = { object: "list"; has_more: boolean; data: T[] }

export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    search.set(k, String(v))
  }
  const s = search.toString()
  return s ? `?${s}` : ""
}
