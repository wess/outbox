/**
 * Client for an Inkling delivery API.
 *
 * Inkling is a headless CMS on the same Atlas stack. Its public delivery
 * surface is `/content` with an `ink_` API key, which is exactly enough to pull
 * a published entry and turn it into an email.
 */
import { invalidParameter } from "../errors/index.ts"

export type InklingConfig = {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
}

export type InklingType = {
  name: string
  label: string
  pluralLabel?: string
  kind: "collection" | "single"
  fields: { key: string; type: string; label: string }[]
}

export type InklingEntry = {
  id: string
  slug: string
  title: string
  locale?: string
  publishedAt?: string | null
  [field: string]: unknown
}

export type InklingList<T> = { data: T[]; meta?: { total: number; page: number; limit: number } }

const request = async <T>(config: InklingConfig, path: string): Promise<T> => {
  const url = `${config.baseUrl.replace(/\/$/, "")}${path}`

  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "user-agent": "outbox/0.1.0 (+integration)",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
    })
  } catch (err) {
    // A DNS failure or refused connection is a configuration problem, not a
    // server fault — say so with the URL that failed.
    throw invalidParameter(`Could not reach Inkling at ${url}: ${(err as Error).message}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw invalidParameter("Inkling rejected the API key. Reconnect with a fresh token.")
  }
  if (res.status === 404) {
    throw invalidParameter(`Inkling has nothing at ${path}.`)
  }
  if (!res.ok) {
    throw invalidParameter(`Inkling returned ${res.status} for ${path}.`)
  }

  return (await res.json()) as T
}

export const createInklingClient = (config: InklingConfig) => ({
  /** Content types this key can read. Doubles as the connection health check. */
  types: async (): Promise<InklingType[]> => {
    const body = await request<InklingList<InklingType>>(config, "/content")
    return body.data ?? []
  },

  entries: async (
    type: string,
    opts: { limit?: number; page?: number; term?: string } = {},
  ): Promise<InklingList<InklingEntry>> => {
    const params = new URLSearchParams()
    params.set("limit", String(Math.min(100, Math.max(1, opts.limit ?? 20))))
    if (opts.page) params.set("page", String(opts.page))
    if (opts.term) params.set("term", opts.term)
    return request<InklingList<InklingEntry>>(
      config,
      `/content/${encodeURIComponent(type)}?${params}`,
    )
  },

  entry: async (type: string, slug: string): Promise<InklingEntry> => {
    const body = await request<{ data: InklingEntry }>(
      config,
      `/content/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`,
    )
    if (!body.data) throw invalidParameter(`Inkling has no ${type} entry with slug "${slug}".`)
    return body.data
  },

  /** Site settings, used to title emails built from content. */
  settings: async (): Promise<Record<string, unknown>> => {
    try {
      const body = await request<{ data: Record<string, unknown> }>(config, "/site/settings")
      return body.data ?? {}
    } catch {
      // Optional — a key scoped to content types cannot read settings, and that
      // should not stop an email being built.
      return {}
    }
  },
})

export type InklingClient = ReturnType<typeof createInklingClient>

// ------------------------------------------------------------- rendering --

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const FIELD_CANDIDATES = ["body", "content", "html", "richText", "rich_text", "text", "markdown"]

// Delivery returns custom fields nested under `data`, while the CMS-side hook
// flattens them. Search both, and never fall back onto metadata.
const META_KEYS = new Set([
  "id",
  "slug",
  "title",
  "locale",
  "publishedAt",
  "updatedAt",
  "createdAt",
  "seo",
  "terms",
  "author",
  "data",
])

const fieldBag = (entry: InklingEntry): Record<string, unknown> => {
  const nested = entry.data
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...(nested as Record<string, unknown>), ...entry }
    : entry
}

/** Picks the field most likely to hold the entry's prose. */
export const bodyOf = (entry: InklingEntry): string => {
  const bag = fieldBag(entry)
  for (const key of FIELD_CANDIDATES) {
    const value = bag[key]
    if (typeof value === "string" && value.trim()) return value
  }
  // Otherwise the longest string field that is not metadata.
  let best = ""
  for (const [key, value] of Object.entries(bag)) {
    if (META_KEYS.has(key)) continue
    if (typeof value === "string" && value.length > best.length) best = value
  }
  return best
}

export const excerptOf = (entry: InklingEntry, max = 160): string => {
  const bag = fieldBag(entry)
  const seo = entry.seo as { description?: unknown } | undefined
  const explicit = bag.excerpt ?? bag.summary ?? bag.description ?? seo?.description
  const source = typeof explicit === "string" && explicit.trim() ? explicit : bodyOf(entry)
  const text = source
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

const imageUrl = (entry: InklingEntry): string | null => {
  const bag = fieldBag(entry)
  const seo = entry.seo as { image?: unknown } | undefined
  const candidates = [
    bag.image,
    bag.coverImage,
    bag.cover_image,
    bag.hero,
    bag.featuredImage,
    bag.thumbnail,
    seo?.image,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && /^https?:\/\//.test(value)) return value
    if (value && typeof value === "object") {
      const url =
        (value as { url?: unknown; src?: unknown }).url ?? (value as { src?: unknown }).src
      if (typeof url === "string" && /^https?:\/\//.test(url)) return url
    }
  }
  return null
}

export type EntryRenderOptions = {
  /** Public site URL, used to link the entry. */
  siteUrl?: string | null
  /** Path template; `:type` and `:slug` are substituted. */
  pathTemplate?: string
  /** Appended below the content — an unsubscribe line, usually. */
  footerHtml?: string
}

/**
 * Turns an entry into email-ready HTML.
 *
 * Deliberately plain: tables, inline styles, no external CSS. Email clients are
 * twenty years behind browsers and a layout that survives them looks like this.
 */
export const entryToHtml = (
  entry: InklingEntry,
  type: string,
  opts: EntryRenderOptions = {},
): string => {
  const title = escapeHtml(entry.title ?? "Untitled")
  const body = bodyOf(entry)
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(body)
  const content = looksLikeHtml
    ? body
    : body
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
        .join("")

  const image = imageUrl(entry)
  const link = opts.siteUrl
    ? `${opts.siteUrl.replace(/\/$/, "")}${(opts.pathTemplate ?? "/:type/:slug")
        .replace(":type", encodeURIComponent(type))
        .replace(":slug", encodeURIComponent(entry.slug))}`
    : null

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f6f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
${image ? `<tr><td><img src="${escapeHtml(image)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto" /></td></tr>` : ""}
<tr><td style="padding:32px 32px 8px">
  <h1 style="margin:0 0 6px;font-size:24px;line-height:1.25;font-weight:600">${title}</h1>
</td></tr>
<tr><td style="padding:8px 32px 24px;font-size:16px;line-height:1.6">
  ${content}
</td></tr>
${
  link
    ? `<tr><td style="padding:0 32px 32px">
  <a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px">Read it on the site</a>
</td></tr>`
    : ""
}
${
  opts.footerHtml
    ? `<tr><td style="padding:20px 32px;border-top:1px solid #ececee;font-size:12px;line-height:1.6;color:#77777f">${opts.footerHtml}</td></tr>`
    : ""
}
</table>
</td></tr></table>
</body></html>`
}

export const entryToText = (
  entry: InklingEntry,
  type: string,
  opts: EntryRenderOptions = {},
): string => {
  const body = bodyOf(entry)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  const link = opts.siteUrl
    ? `${opts.siteUrl.replace(/\/$/, "")}${(opts.pathTemplate ?? "/:type/:slug")
        .replace(":type", type)
        .replace(":slug", entry.slug)}`
    : null

  return [
    entry.title ?? "Untitled",
    "",
    body,
    ...(link ? ["", `Read it on the site: ${link}`] : []),
  ].join("\n")
}
