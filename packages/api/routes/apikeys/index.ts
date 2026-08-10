import { apiKeyObject, issueApiKey, notFound, paginate, parsePageQuery } from "@outbox/core"
import { db } from "@outbox/core/db"
import { type ApiKey, apiKeys } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

export const apiKeyRoutes: Route[] = [
  postR(
    "/api-keys",
    {
      body: z.object({
        name: z.string().min(1),
        permission: z.enum(["full_access", "sending_access"]).optional(),
        domain_id: z.string().uuid().optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const auth = authOf(c)
      const issued = await issueApiKey({
        teamId: auth.teamId,
        name: c.body.name,
        permission: c.body.permission,
        domainId: c.body.domain_id ?? null,
        createdBy: auth.userId,
      })
      // The plaintext token is returned exactly once.
      return json(c, 201, { id: issued.row.id, token: issued.token })
    },
  ),

  getR(
    "/api-keys",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<ApiKey>({
        table: "api_keys",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(apiKeyObject) })
    },
  ),

  delR(
    "/api-keys/:api_key_id",
    {
      params: z.object({ api_key_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await db().one<ApiKey>(
        from(apiKeys).where((q) => [
          q("id").equals(c.params.api_key_id),
          q("team_id").equals(teamId),
        ]),
      )
      if (!row) throw notFound("API key not found")
      await db().execute(
        from(apiKeys)
          .where((q) => [q("id").equals(row.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, {})
    },
  ),
]
