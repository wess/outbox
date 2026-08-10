import { emit, normalizeEmail, PIXEL, verifyToken } from "@outbox/core"
import { db } from "@outbox/core/db"
import { contacts, emails, trackingLinks } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { type Conn, get, json, pipe, post, type Route, redirect } from "@wess/atlas/server"

const noStore = (conn: Conn): Conn => ({
  ...conn,
  respHeaders: new Headers([
    ...conn.respHeaders,
    ["cache-control", "no-store, no-cache, must-revalidate, private"],
    ["pragma", "no-cache"],
  ]),
})

const pixelResponse = (conn: Conn): Conn => ({
  ...noStore(conn),
  status: 200,
  body: PIXEL as unknown as string,
  respHeaders: new Headers([
    ...noStore(conn).respHeaders,
    ["content-type", "image/gif"],
    ["content-length", String(PIXEL.byteLength)],
  ]),
})

const html = (conn: Conn, status: number, body: string): Conn => ({
  ...conn,
  status,
  body,
  respHeaders: new Headers([...conn.respHeaders, ["content-type", "text/html; charset=utf-8"]]),
})

const page = (title: string, message: string, extra = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
         display: grid; place-items: center; min-height: 100vh; margin: 0;
         background: #fafafa; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #09090b; color: #fafafa; } }
  main { max-width: 27rem; padding: 2.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0; opacity: .7; }
  button { margin-top: 1.5rem; padding: .6rem 1.1rem; border-radius: .5rem;
           border: 1px solid currentColor; background: transparent; color: inherit;
           font: inherit; cursor: pointer; }
</style></head>
<body><main><h1>${title}</h1><p>${message}</p>${extra}</main></body></html>`

// Bots and mail-scanner prefetches inflate open counts; the obvious ones are
// cheap to drop.
const isPrefetch = (conn: Conn): boolean => {
  const ua = (conn.headers.get("user-agent") ?? "").toLowerCase()
  if (!ua) return true
  return ["googleimageproxy", "bot", "crawler", "spider", "preview", "scanner"].some((s) =>
    ua.includes(s),
  )
}

export const trackingRoutes: Route[] = [
  get(
    "/t/o/:token",
    pipe(async (c) => {
      const raw = (c.params.token ?? "").replace(/\.gif$/, "")
      const value = verifyToken(raw)
      if (!value) return pixelResponse(c)
      const [emailId, recipient] = value.split(":")
      if (!emailId || isPrefetch(c)) return pixelResponse(c)

      const email = await db().one(
        from(emails)
          .select("id", "team_id")
          .where((q) => q("id").equals(emailId)),
      )
      if (email) {
        await emit({
          teamId: email.team_id,
          type: "email.opened",
          emailId: email.id,
          recipient: recipient ?? null,
          data: {
            user_agent: c.headers.get("user-agent"),
            ip: c.headers.get("x-forwarded-for"),
          },
          updateLastEvent: true,
        })
      }
      return pixelResponse(c)
    }),
  ),

  get(
    "/t/c/:token",
    pipe(async (c) => {
      const value = verifyToken(c.params.token ?? "")
      if (!value) return html(c, 400, page("Invalid link", "This tracking link is not valid."))
      const [linkId, recipient] = value.split(":")
      if (!linkId) return html(c, 400, page("Invalid link", "This tracking link is not valid."))

      const link = await db().one<{ id: string; url: string; email_id: string; team_id: string }>(
        from(trackingLinks).where((q) => q("id").equals(linkId)),
      )
      if (!link) return html(c, 404, page("Link not found", "This link has expired."))

      await emit({
        teamId: link.team_id,
        type: "email.clicked",
        emailId: link.email_id,
        recipient: recipient ?? null,
        data: {
          link: { url: link.url },
          link_id: link.id,
          user_agent: c.headers.get("user-agent"),
        },
        updateLastEvent: true,
      })

      return redirect(noStore(c), link.url, 302)
    }),
  ),

  get(
    "/u/:token",
    pipe(async (c) => {
      const value = verifyToken(c.params.token ?? "")
      if (!value) return html(c, 400, page("Invalid link", "This unsubscribe link is not valid."))
      const [, recipient] = value.split(":")
      const form = `<form method="post" action="/u/${c.params.token}"><button type="submit">Confirm unsubscribe</button></form>`
      return html(
        c,
        200,
        page(
          "Unsubscribe",
          `Stop sending email to <strong>${recipient ?? "this address"}</strong>?`,
          form,
        ),
      )
    }),
  ),

  // One-click unsubscribe (RFC 8058) posts here directly from the mail client.
  post(
    "/u/:token",
    pipe(async (c) => {
      const value = verifyToken(c.params.token ?? "")
      if (!value) return html(c, 400, page("Invalid link", "This unsubscribe link is not valid."))
      const [emailId, recipient, topicId] = value.split(":")
      if (!emailId || !recipient) {
        return html(c, 400, page("Invalid link", "This unsubscribe link is not valid."))
      }

      const email = await db().one(
        from(emails)
          .select("id", "team_id")
          .where((q) => q("id").equals(emailId)),
      )
      if (!email) return html(c, 404, page("Not found", "This unsubscribe link has expired."))

      const address = normalizeEmail(recipient)
      const contact = await db().one<{ id: string }>(
        from(contacts)
          .select("id")
          .where((q) => [q("team_id").equals(email.team_id), q("email").equals(address)]),
      )

      if (topicId && contact) {
        // Topic-scoped unsubscribe only opts out of that topic.
        await db().execute({
          text: `INSERT INTO contact_topics (contact_id, topic_id, subscription)
                 VALUES ($1, $2, 'opt_out')
                 ON CONFLICT (contact_id, topic_id)
                 DO UPDATE SET subscription = 'opt_out', updated_at = now()`,
          values: [contact.id, topicId],
        })
      } else if (contact) {
        await db().execute(
          from(contacts)
            .where((q) => q("id").equals(contact.id))
            .update({ unsubscribed: true, unsubscribed_at: new Date(), updated_at: new Date() }),
        )
      } else {
        await db().execute({
          text: `INSERT INTO suppressions (team_id, email, origin, source_id)
                 VALUES ($1, $2, 'manual', $3)
                 ON CONFLICT (team_id, email) DO NOTHING`,
          values: [email.team_id, address, email.id],
        })
      }

      return html(c, 200, page("Unsubscribed", `${address} will no longer receive these emails.`))
    }),
  ),

  get(
    "/health",
    pipe(async (c) => {
      try {
        await db().all<{ ok: number }>({ text: "SELECT 1 AS ok", values: [] })
        return json(c, 200, { status: "ok", version: "0.1.0" })
      } catch {
        return json(c, 503, { status: "degraded", database: "unreachable" })
      }
    }),
  ),
]
