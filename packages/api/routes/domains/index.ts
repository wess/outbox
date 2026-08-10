import {
  createDomain,
  dispatch,
  domainListItem,
  domainObject,
  notFound,
  paginate,
  parsePageQuery,
  syncRecords,
  verifyDomain,
} from "@outbox/core"
import { db } from "@outbox/core/db"
import { type Domain, type DomainRecord, domainRecords, domains } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const domainParam = z.object({ domain_id: z.string().uuid() })

const capabilities = z
  .object({
    sending: z.enum(["enabled", "disabled"]).optional(),
    receiving: z.enum(["enabled", "disabled"]).optional(),
  })
  .optional()

const find = async (teamId: string, id: string): Promise<Domain> => {
  const row = await db().one<Domain>(
    from(domains).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Domain not found")
  return row
}

const recordsOf = (domainId: string): Promise<DomainRecord[]> =>
  db().all<DomainRecord>(from(domainRecords).where((q) => q("domain_id").equals(domainId)))

export const domainRoutes: Route[] = [
  postR(
    "/domains",
    {
      body: z.object({
        name: z.string().min(1),
        region: z.string().optional(),
        custom_return_path: z.string().optional(),
        open_tracking: z.boolean().optional(),
        click_tracking: z.boolean().optional(),
        tracking_subdomain: z.string().optional(),
        tls: z.enum(["opportunistic", "enforced"]).optional(),
        capabilities,
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const { domain, records } = await createDomain({
        teamId,
        name: c.body.name,
        region: c.body.region,
        customReturnPath: c.body.custom_return_path,
        openTracking: c.body.open_tracking,
        clickTracking: c.body.click_tracking,
        trackingSubdomain: c.body.tracking_subdomain,
        tls: c.body.tls,
        sending: c.body.capabilities?.sending,
        receiving: c.body.capabilities?.receiving,
      })
      await dispatch(teamId, "domain.created", { domain_id: domain.id, name: domain.name })
      return json(c, 201, domainObject(domain, records))
    },
  ),

  getR(
    "/domains",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Domain>({
        table: "domains",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(domainListItem) })
    },
  ),

  getR(
    "/domains/:domain_id",
    { params: domainParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const domain = await find(authOf(c).teamId, c.params.domain_id)
      return json(c, 200, domainObject(domain, await recordsOf(domain.id)))
    },
  ),

  postR(
    "/domains/:domain_id/verify",
    { params: domainParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const domain = await find(authOf(c).teamId, c.params.domain_id)
      const result = await verifyDomain(domain)
      return json(c, 200, {
        object: "domain",
        id: result.domain.id,
        status: result.domain.status,
        records: domainObject(result.domain, result.records).records,
      })
    },
  ),

  patchR(
    "/domains/:domain_id",
    {
      params: domainParam,
      body: z.object({
        click_tracking: z.boolean().optional(),
        open_tracking: z.boolean().optional(),
        tracking_subdomain: z.string().optional(),
        tls: z.enum(["opportunistic", "enforced"]).optional(),
        custom_return_path: z.string().optional(),
        capabilities,
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const domain = await find(teamId, c.params.domain_id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.click_tracking !== undefined) patch.click_tracking = c.body.click_tracking
      if (c.body.open_tracking !== undefined) patch.open_tracking = c.body.open_tracking
      if (c.body.tracking_subdomain !== undefined)
        patch.tracking_subdomain = c.body.tracking_subdomain
      if (c.body.tls !== undefined) patch.tls = c.body.tls
      if (c.body.custom_return_path !== undefined)
        patch.custom_return_path = c.body.custom_return_path
      if (c.body.capabilities?.sending) patch.sending = c.body.capabilities.sending
      if (c.body.capabilities?.receiving) patch.receiving = c.body.capabilities.receiving

      const updated = (await db().one(
        from(domains)
          .where((q) => [q("id").equals(domain.id), q("team_id").equals(teamId)])
          .update(patch)
          .returning("id", "name"),
      ))!

      // Tracking and receiving toggles change which DNS records apply.
      const fresh = await find(teamId, domain.id)
      await syncRecords(fresh)
      await dispatch(teamId, "domain.updated", { domain_id: domain.id, name: updated.name })

      return json(c, 200, { object: "domain", id: domain.id })
    },
  ),

  delR(
    "/domains/:domain_id",
    { params: domainParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const domain = await find(teamId, c.params.domain_id)
      await db().execute(
        from(domains)
          .where((q) => [q("id").equals(domain.id), q("team_id").equals(teamId)])
          .del(),
      )
      await dispatch(teamId, "domain.deleted", { domain_id: domain.id, name: domain.name })
      return json(c, 200, { object: "domain", id: domain.id, deleted: true })
    },
  ),
]
