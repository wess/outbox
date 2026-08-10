import { createHmac, timingSafeEqual } from "node:crypto"
import { config } from "@outbox/config"
import { trackingLinks } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { db } from "../db/index.ts"

// A 1x1 transparent GIF, the smallest thing every client will render.
export const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
)

const sign = (value: string): string =>
  createHmac("sha256", config.jwtSecret).update(value).digest("base64url").slice(0, 27)

export const signToken = (value: string): string => `${value}.${sign(value)}`

export const verifyToken = (token: string): string | null => {
  const idx = token.lastIndexOf(".")
  if (idx <= 0) return null
  const value = token.slice(0, idx)
  const provided = token.slice(idx + 1)
  const expected = sign(value)
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null
  return value
}

const trackingBase = (domain: { tracking_subdomain: string; name: string } | null): string =>
  domain ? `https://${domain.tracking_subdomain}.${domain.name}` : config.publicUrl

export const openPixelUrl = (
  emailId: string,
  recipient: string,
  domain: Parameters<typeof trackingBase>[0],
): string => `${trackingBase(domain)}/t/o/${signToken(`${emailId}:${recipient}`)}.gif`

export const clickUrl = (
  linkId: string,
  recipient: string,
  domain: Parameters<typeof trackingBase>[0],
): string => `${trackingBase(domain)}/t/c/${signToken(`${linkId}:${recipient}`)}`

export const unsubscribeUrl = (
  emailId: string,
  recipient: string,
  topicId?: string | null,
): string => `${config.publicUrl}/u/${signToken(`${emailId}:${recipient}:${topicId ?? ""}`)}`

const HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi

// Skips anchors we must not rewrite: unsubscribe links, mailto/tel, and
// fragment-only targets.
const rewritable = (url: string): boolean =>
  /^https?:\/\//i.test(url) && !url.includes("/u/") && !url.includes("{{")

export type TrackingResult = { html: string; links: { id: string; url: string }[] }

export const applyClickTracking = async (
  html: string,
  emailId: string,
  teamId: string,
  recipient: string,
  domain: Parameters<typeof trackingBase>[0],
): Promise<TrackingResult> => {
  const conn = db()
  const found: { id: string; url: string }[] = []
  const targets: string[] = []
  html.replace(HREF, (_m, _pre, _q, url: string) => {
    if (rewritable(url) && !targets.includes(url)) targets.push(url)
    return _m
  })
  if (targets.length === 0) return { html, links: [] }

  const rows = await conn.all<{ id: string; url: string }>(
    from(trackingLinks)
      .insertMany(targets.map((url) => ({ team_id: teamId, email_id: emailId, url })))
      .returning("id", "url"),
  )
  const byUrl = new Map(rows.map((r) => [r.url, r.id]))
  found.push(...rows)

  const rewritten = html.replace(HREF, (match, pre: string, quote: string, url: string) => {
    const id = byUrl.get(url)
    if (!id || !rewritable(url)) return match
    return `${pre}${quote}${clickUrl(id, recipient, domain)}${quote}`
  })
  return { html: rewritten, links: found }
}

export const appendOpenPixel = (
  html: string,
  emailId: string,
  recipient: string,
  domain: Parameters<typeof trackingBase>[0],
): string => {
  const img = `<img src="${openPixelUrl(emailId, recipient, domain)}" width="1" height="1" alt="" style="display:none" />`
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : html + img
}

// Replaces the unsubscribe placeholder tokens with a real, signed URL.
export const injectUnsubscribe = (
  body: string,
  emailId: string,
  recipient: string,
  topicId?: string | null,
): string => {
  const url = unsubscribeUrl(emailId, recipient, topicId)
  return body
    .replace(/\{\{\{\s*OUTBOX_UNSUBSCRIBE_URL\s*\}\}\}/g, url)
    .replace(/\{\{\{\s*RESEND_UNSUBSCRIBE_URL\s*\}\}\}/g, url)
}
