import { config } from "@outbox/config"
import { errorBody, notFound } from "@outbox/core"
import dashboard from "@outbox/web/index.html"
import { withSecurityHeaders } from "@wess/atlas/security"
import { type Route, router } from "@wess/atlas/server"
import { wrapAll } from "./pipes/index.ts"
import { apiKeyRoutes } from "./routes/apikeys/index.ts"
import { automationRoutes, eventRoutes } from "./routes/automations/index.ts"
import { broadcastRoutes } from "./routes/broadcasts/index.ts"
import {
  audienceContactRoutes,
  contactPropertyRoutes,
  contactRoutes,
  topicRoutes,
} from "./routes/contacts/index.ts"
import { dashboardRoutes } from "./routes/dashboard/index.ts"
import { domainRoutes } from "./routes/domains/index.ts"
import { emailRoutes } from "./routes/emails/index.ts"
import { integrationRoutes } from "./routes/integrations/index.ts"
import { segmentRoutes, suppressionRoutes } from "./routes/segments/index.ts"
import { templateRoutes } from "./routes/templates/index.ts"
import { trackingRoutes } from "./routes/tracking/index.ts"
import { logRoutes, webhookRoutes } from "./routes/webhooks/index.ts"

/**
 * Route order matters: @wess/atlas/server matches in registration order, so
 * every static segment must be registered before the `:id` pattern that would
 * otherwise swallow it.
 */
export const apiRoutes = (): Route[] => [
  ...wrapAll(emailRoutes),
  ...wrapAll(domainRoutes),
  ...wrapAll(apiKeyRoutes),
  ...wrapAll(broadcastRoutes),
  ...wrapAll(contactPropertyRoutes),
  ...wrapAll(topicRoutes),
  ...wrapAll(audienceContactRoutes),
  ...wrapAll(segmentRoutes),
  ...wrapAll(suppressionRoutes),
  ...wrapAll(templateRoutes),
  ...wrapAll(webhookRoutes),
  ...wrapAll(logRoutes),
  ...wrapAll(integrationRoutes),
  ...wrapAll(automationRoutes),
  ...wrapAll(eventRoutes),
  ...wrapAll(contactRoutes),
]

export const allRoutes = (): Route[] => [
  // Tracking and dashboard endpoints are not part of the public email API and
  // are not access-logged as such.
  ...wrapAll(trackingRoutes, { log: false }),
  ...wrapAll(dashboardRoutes, { log: false }),
  ...apiRoutes(),
]

const notFoundBody = JSON.stringify(errorBody(notFound("The requested endpoint does not exist.")))

export const buildFetch = (): ((req: Request) => Promise<Response>) => {
  const handle = router(...allRoutes())
  return async (req: Request): Promise<Response> => {
    const res = await handle(req)
    // The router's own 404 is plain text; re-render it in the API envelope.
    if (res.status === 404 && (res.headers.get("content-type") ?? "").startsWith("text/plain")) {
      return new Response(notFoundBody, {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }
    return res
  }
}

export const startApi = (port = config.port) => {
  // API responses are JSON for machine clients, but the dashboard and the
  // unsubscribe pages are HTML, so CSP stays on.
  const fetch = withSecurityHeaders(buildFetch(), {
    dev: process.env.NODE_ENV !== "production",
  })

  const server = Bun.serve({
    port,
    idleTimeout: 60,
    // The dashboard lives under /app so the API keeps the root paths a Resend
    // SDK expects. Bun bundles the React entry from the HTML import.
    routes: {
      "/app": dashboard,
      "/app/*": dashboard,
      "/": Response.redirect("/app/emails", 302),
    },
    fetch,
  })

  console.log(`[outbox] api        http://localhost:${server.port}`)
  console.log(`[outbox] dashboard  http://localhost:${server.port}/app`)
  return server
}
