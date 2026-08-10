import {
  ConnectionTokenError,
  checkIntegration,
  connectIntegration,
  disconnectIntegration,
  entryToHtml,
  entryToText,
  excerptOf,
  findIntegration,
  inklingFor,
  integrationObject,
  invalidParameter,
  isProvider,
  listEnvelope,
  notFound,
  requireIntegration,
  updateIntegrationSettings,
} from "@outbox/core"
import { db } from "@outbox/core/db"
import { type Integration, integrations } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const providerParam = z.object({ provider: z.string().min(1) })

const asProvider = (value: string) => {
  if (!isProvider(value)) throw notFound(`Unknown integration provider "${value}".`)
  return value
}

export const integrationRoutes: Route[] = [
  /**
   * Pairing is one paste. The token carries the URL, the key, and a label, so
   * there is no second field to get wrong.
   */
  postR(
    "/integrations/connect",
    {
      body: z.object({
        provider: z.string().min(1),
        token: z.string().min(1),
        settings: z.record(z.unknown()).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const provider = asProvider(c.body.provider)
      try {
        const result = await connectIntegration({
          teamId: authOf(c).teamId,
          provider,
          token: c.body.token,
          settings: c.body.settings,
        })
        return json(c, 201, {
          ...integrationObject(result.integration),
          detail: result.detail,
        })
      } catch (err) {
        // A bad paste is a caller error with a specific cause worth surfacing.
        if (err instanceof ConnectionTokenError) throw invalidParameter(err.message)
        throw err
      }
    },
  ),

  getR("/integrations", { before: authedFull, assigns: {} as never }, async (c) => {
    const rows = await db().all<Integration>(
      from(integrations).where((q) => q("team_id").equals(authOf(c).teamId)),
    )
    return json(c, 200, listEnvelope(rows.map(integrationObject)))
  }),

  getR(
    "/integrations/:provider",
    { params: providerParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const provider = asProvider(c.params.provider)
      const row = await findIntegration(authOf(c).teamId, provider)
      if (!row) throw notFound(`No ${provider} connection.`)
      return json(c, 200, integrationObject(row))
    },
  ),

  postR(
    "/integrations/:provider/check",
    { params: providerParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const provider = asProvider(c.params.provider)
      const result = await checkIntegration(authOf(c).teamId, provider)
      return json(c, 200, { object: "integration_check", provider, ...result })
    },
  ),

  patchR(
    "/integrations/:provider",
    {
      params: providerParam,
      body: z.object({ settings: z.record(z.unknown()) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const provider = asProvider(c.params.provider)
      const row = await updateIntegrationSettings(authOf(c).teamId, provider, c.body.settings)
      return json(c, 200, integrationObject(row))
    },
  ),

  delR(
    "/integrations/:provider",
    { params: providerParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const provider = asProvider(c.params.provider)
      await requireIntegration(authOf(c).teamId, provider)
      await disconnectIntegration(authOf(c).teamId, provider)
      return json(c, 200, { object: "integration", provider, deleted: true })
    },
  ),

  // ------------------------------------------------------- inkling content --

  getR("/integrations/inkling/types", { before: authedFull, assigns: {} as never }, async (c) => {
    const client = await inklingFor(authOf(c).teamId)
    return json(c, 200, listEnvelope(await client.types()))
  }),

  getR(
    "/integrations/inkling/content/:type",
    {
      params: z.object({ type: z.string().min(1) }),
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const q = (c.query ?? {}) as Record<string, string>
      const client = await inklingFor(authOf(c).teamId)
      const list = await client.entries(c.params.type, {
        limit: q.limit ? Number(q.limit) : 20,
        page: q.page ? Number(q.page) : undefined,
        term: q.term,
      })
      return json(c, 200, {
        object: "list",
        has_more: Boolean(list.meta && list.meta.page * list.meta.limit < list.meta.total),
        data: list.data.map((entry) => ({
          id: entry.id,
          slug: entry.slug,
          title: entry.title,
          excerpt: excerptOf(entry),
          published_at: entry.publishedAt ?? null,
        })),
      })
    },
  ),

  /**
   * Renders an Inkling entry into email HTML without sending it, so the
   * dashboard and the CMS can both preview exactly what would go out.
   */
  getR(
    "/integrations/inkling/content/:type/:slug/preview",
    {
      params: z.object({ type: z.string().min(1), slug: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await requireIntegration(teamId, "inkling")
      const client = await inklingFor(teamId)
      const entry = await client.entry(c.params.type, c.params.slug)
      const settings = (row.settings ?? {}) as { site_url?: string; path_template?: string }

      return json(c, 200, {
        object: "preview",
        subject: entry.title,
        excerpt: excerptOf(entry),
        html: entryToHtml(entry, c.params.type, {
          siteUrl: settings.site_url ?? null,
          pathTemplate: settings.path_template,
          footerHtml: '<a href="{{{OUTBOX_UNSUBSCRIBE_URL}}}">Unsubscribe</a>',
        }),
        text: entryToText(entry, c.params.type, { siteUrl: settings.site_url ?? null }),
      })
    },
  ),
]
