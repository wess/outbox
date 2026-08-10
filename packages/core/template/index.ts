export type RenderContext = Record<string, unknown>

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

// Resolves `contact.first_name` style dotted paths.
const lookup = (ctx: RenderContext, path: string): unknown => {
  const parts = path.split(".")
  let current: unknown = ctx
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const stringify = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

// `{{{ KEY | fallback }}}` renders raw, `{{ KEY }}` renders HTML-escaped.
const TRIPLE = /\{\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}\}/g
const DOUBLE = /\{\{\s*([^}|{]+?)\s*(?:\|\s*([^}{]*?)\s*)?\}\}/g

export type RenderOptions = {
  // Values used when a key resolves to nothing, from the template's declared
  // variables or a contact property definition.
  fallbacks?: Record<string, unknown>
  escape?: boolean
}

export const render = (
  input: string | null | undefined,
  ctx: RenderContext,
  opts: RenderOptions = {},
): string => {
  if (!input) return ""
  const { fallbacks = {} } = opts

  const resolve = (key: string, inline: string | undefined): string => {
    const direct = lookup(ctx, key)
    if (direct !== undefined && direct !== null && direct !== "") return stringify(direct)
    if (inline !== undefined) return inline
    const declared = fallbacks[key]
    if (declared !== undefined && declared !== null) return stringify(declared)
    return ""
  }

  return input
    .replace(TRIPLE, (_m, key: string, inline?: string) => resolve(key.trim(), inline))
    .replace(DOUBLE, (_m, key: string, inline?: string) => escapeHtml(resolve(key.trim(), inline)))
}

// Every `{{{key}}}` / `{{key}}` referenced by a body, for validation and for
// showing the operator which variables a template actually uses.
export const extractVariables = (input: string | null | undefined): string[] => {
  if (!input) return []
  const keys = new Set<string>()
  for (const m of input.matchAll(TRIPLE)) if (m[1]) keys.add(m[1].trim())
  for (const m of input.matchAll(DOUBLE)) if (m[1]) keys.add(m[1].trim())
  return [...keys]
}

export const UNSUBSCRIBE_TOKENS = ["OUTBOX_UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL"] as const

export const hasUnsubscribeToken = (input: string | null | undefined): boolean =>
  UNSUBSCRIBE_TOKENS.some((t) => Boolean(input?.includes(t)))

// Contact-facing context shared by broadcasts, automations, and topic emails.
export const contactContext = (contact: {
  email: string
  first_name?: string | null
  last_name?: string | null
  properties?: Record<string, unknown>
}): RenderContext => ({
  contact: {
    email: contact.email,
    first_name: contact.first_name ?? "",
    last_name: contact.last_name ?? "",
    ...(contact.properties ?? {}),
  },
  ...(contact.properties ?? {}),
})
