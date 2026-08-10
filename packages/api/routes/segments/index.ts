import {
  contactObject,
  dispatch,
  normalizeEmail,
  notFound,
  paginate,
  parsePageQuery,
  segmentObject,
  suppressionObject,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import { anyOf, jsonArray } from "@outbox/core/pagination"
import { type Contact, type Segment, type Suppression, segments } from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const segmentParam = z.object({ segment_id: z.string().uuid() })

const findSegment = async (teamId: string, id: string): Promise<Segment> => {
  const row = await db().one<Segment>(
    from(segments).where((q) => [q("id").equals(id), q("team_id").equals(teamId)]),
  )
  if (!row) throw notFound("Segment not found")
  return row
}

// Audiences were renamed to Segments; both paths stay mounted so older SDKs work.
const segmentEndpoints = (base: "segments" | "audiences"): Route[] => [
  postR(
    `/${base}`,
    { body: z.object({ name: z.string().min(1) }), before: authedFull, assigns: {} as never },
    async (c) => {
      const row = (await db().one<Segment>(
        from(segments)
          .insert({ team_id: authOf(c).teamId, name: c.body.name })
          .returning(...allColumns(segments)),
      ))!
      return json(c, 201, {
        object: base === "segments" ? "segment" : "audience",
        id: row.id,
        name: row.name,
      })
    },
  ),

  getR(
    `/${base}`,
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Segment>({
        table: "segments",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(segmentObject) })
    },
  ),

  getR(
    `/${base}/:segment_id/contacts`,
    {
      params: segmentParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      await findSegment(teamId, c.params.segment_id)
      const page = await paginate<Contact>({
        table: "contacts",
        teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        where: "id IN (SELECT contact_id FROM segment_contacts WHERE segment_id = $1)",
        values: [c.params.segment_id],
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map((row) => contactObject(row)) })
    },
  ),

  getR(
    `/${base}/:segment_id`,
    { params: segmentParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await findSegment(authOf(c).teamId, c.params.segment_id)
      return json(c, 200, segmentObject(row))
    },
  ),

  delR(
    `/${base}/:segment_id`,
    { params: segmentParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await findSegment(teamId, c.params.segment_id)
      await db().execute(
        from(segments)
          .where((q) => [q("id").equals(row.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, { object: "segment", id: row.id, deleted: true })
    },
  ),
]

export const segmentRoutes: Route[] = [
  ...segmentEndpoints("segments"),
  ...segmentEndpoints("audiences"),
]

const addSuppression = async (
  teamId: string,
  email: string,
  origin = "manual",
  sourceId: string | null = null,
): Promise<Suppression> => {
  const row = await db().one<Suppression>({
    text: `INSERT INTO suppressions (team_id, email, origin, source_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id, email) DO UPDATE SET origin = EXCLUDED.origin
           RETURNING *`,
    values: [teamId, normalizeEmail(email), origin, sourceId],
  })
  await dispatch(teamId, "suppression.added", { email: normalizeEmail(email), origin })
  return row!
}

export const suppressionRoutes: Route[] = [
  postR(
    "/suppressions/batch/add",
    {
      body: z.object({ emails: z.array(z.string().email()).min(1).max(100) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const data: { id: string; email: string }[] = []
      for (const email of c.body.emails) {
        const row = await addSuppression(teamId, email)
        data.push({ id: row.id, email: row.email })
      }
      return json(c, 201, { object: "list", data })
    },
  ),

  postR(
    "/suppressions/batch/remove",
    {
      body: z.object({
        emails: z.array(z.string().email()).max(100).optional(),
        ids: z.array(z.string().uuid()).max(100).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const emails = (c.body.emails ?? []).map(normalizeEmail)
      const ids = c.body.ids ?? []
      if (!emails.length && !ids.length) {
        return json(c, 200, { object: "list", data: [] })
      }
      const removed = await db().all<Suppression>({
        text: `DELETE FROM suppressions
               WHERE team_id = $1
                 AND (email = ANY(${anyOf(2, "text")}) OR id = ANY(${anyOf(3, "uuid")}))
               RETURNING *`,
        values: [teamId, jsonArray(emails), jsonArray(ids)],
      })
      for (const row of removed) {
        await dispatch(teamId, "suppression.removed", { email: row.email })
      }
      return json(c, 200, {
        object: "list",
        data: removed.map((r) => ({ id: r.id, email: r.email })),
      })
    },
  ),

  postR(
    "/suppressions",
    { body: z.object({ email: z.string().email() }), before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await addSuppression(authOf(c).teamId, c.body.email)
      return json(c, 201, { object: "suppression", id: row.id, email: row.email })
    },
  ),

  getR(
    "/suppressions",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const q = (c.query ?? {}) as Record<string, string>
      const page = await paginate<Suppression>({
        table: "suppressions",
        teamId: authOf(c).teamId,
        query: parsePageQuery(q),
        ...(q.origin ? { where: "origin = $1", values: [q.origin] } : {}),
      })
      return json(c, 200, { ...page, data: page.data.map(suppressionObject) })
    },
  ),

  getR(
    "/suppressions/:suppression",
    {
      params: z.object({ suppression: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const value = c.params.suppression
      const row = await db().one<Suppression>({
        text: `SELECT * FROM suppressions
               WHERE team_id = $1 AND (email = $2 OR (id::text = $2))`,
        values: [teamId, normalizeEmail(value)],
      })
      if (!row) throw notFound("Suppression not found")
      return json(c, 200, suppressionObject(row))
    },
  ),

  delR(
    "/suppressions/:suppression",
    {
      params: z.object({ suppression: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const value = c.params.suppression
      const row = await db().one<Suppression>({
        text: `DELETE FROM suppressions
               WHERE team_id = $1 AND (email = $2 OR (id::text = $2))
               RETURNING *`,
        values: [teamId, normalizeEmail(value)],
      })
      if (!row) throw notFound("Suppression not found")
      await dispatch(teamId, "suppression.removed", { email: row.email })
      return json(c, 200, { object: "suppression", id: row.id, deleted: true })
    },
  ),
]

export { addSuppression, findSegment }
