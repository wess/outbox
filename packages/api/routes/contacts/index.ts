import {
  contactObject,
  contactPropertyObject,
  dispatch,
  invalidParameter,
  listEnvelope,
  normalizeEmail,
  notFound,
  paginate,
  parsePageQuery,
  pgTimestamp,
  segmentObject,
  topicObject,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type Contact,
  type ContactProperty,
  contactProperties,
  contacts,
  type Segment,
  segmentContacts,
  segments,
  type Topic,
  topics,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Contacts are addressable by id or by email in the same path position.
export const findContact = async (teamId: string, idOrEmail: string): Promise<Contact> => {
  const row = await db().one<Contact>(
    from(contacts).where((q) =>
      UUID.test(idOrEmail)
        ? [q("id").equals(idOrEmail), q("team_id").equals(teamId)]
        : [q("email").equals(normalizeEmail(idOrEmail)), q("team_id").equals(teamId)],
    ),
  )
  if (!row) throw notFound("Contact not found")
  return row
}

const propertiesOf = async (
  teamId: string,
  contactId: string,
): Promise<Record<string, unknown>> => {
  const rows = await db().all<{
    key: string
    type: string
    value: string | null
    fallback_value: string | null
  }>({
    text: `SELECT p.key, p.type, v.value, p.fallback_value
           FROM contact_properties p
           LEFT JOIN contact_property_values v
             ON v.property_id = p.id AND v.contact_id = $2
           WHERE p.team_id = $1`,
    values: [teamId, contactId],
  })
  const out: Record<string, unknown> = {}
  for (const r of rows) {
    const raw = r.value ?? r.fallback_value
    if (raw === null) continue
    out[r.key] = r.type === "number" ? Number(raw) : raw
  }
  return out
}

const writeProperties = async (
  teamId: string,
  contactId: string,
  props: Record<string, unknown>,
): Promise<void> => {
  const conn = db()
  const defined = await conn.all<ContactProperty>(
    from(contactProperties).where((q) => q("team_id").equals(teamId)),
  )
  const byKey = new Map(defined.map((p) => [p.key, p]))

  for (const [key, value] of Object.entries(props)) {
    const property = byKey.get(key)
    if (!property) {
      throw invalidParameter(
        `Unknown contact property \`${key}\`. Create it first at /contact-properties.`,
      )
    }
    if (property.type === "number" && value !== null && Number.isNaN(Number(value))) {
      throw invalidParameter(`Contact property \`${key}\` expects a number.`)
    }
    await conn.execute({
      text: `INSERT INTO contact_property_values (contact_id, property_id, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (contact_id, property_id)
             DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      values: [contactId, property.id, value === null ? null : String(value)],
    })
  }
}

const topicSubscription = z.object({
  id: z.string().uuid(),
  subscription: z.enum(["opt_in", "opt_out"]),
})

const writeTopics = async (
  contactId: string,
  entries: { id: string; subscription: string }[],
): Promise<void> => {
  for (const entry of entries) {
    await db().execute({
      text: `INSERT INTO contact_topics (contact_id, topic_id, subscription)
             VALUES ($1, $2, $3)
             ON CONFLICT (contact_id, topic_id)
             DO UPDATE SET subscription = EXCLUDED.subscription, updated_at = now()`,
      values: [contactId, entry.id, entry.subscription],
    })
  }
}

const idParam = z.object({ id: z.string().min(1) })

export const contactRoutes: Route[] = [
  postR(
    "/contacts",
    {
      body: z.object({
        email: z.string().email(),
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        unsubscribed: z.boolean().optional(),
        properties: z.record(z.unknown()).optional(),
        segments: z.array(z.object({ id: z.string().uuid() })).optional(),
        topics: z.array(topicSubscription).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const email = normalizeEmail(c.body.email)

      const existing = await db().one<Contact>(
        from(contacts).where((q) => [q("team_id").equals(teamId), q("email").equals(email)]),
      )
      if (existing) throw invalidParameter("A contact with this email already exists.")

      const row = (await db().one<Contact>(
        from(contacts)
          .insert({
            team_id: teamId,
            email,
            first_name: c.body.first_name ?? null,
            last_name: c.body.last_name ?? null,
            unsubscribed: c.body.unsubscribed ?? false,
            unsubscribed_at: c.body.unsubscribed ? new Date() : null,
          })
          .returning(...allColumns(contacts)),
      ))!

      if (c.body.properties) await writeProperties(teamId, row.id, c.body.properties)
      if (c.body.topics?.length) await writeTopics(row.id, c.body.topics)
      for (const segment of c.body.segments ?? []) {
        await db().execute({
          text: `INSERT INTO segment_contacts (segment_id, contact_id) VALUES ($1, $2)
                 ON CONFLICT (segment_id, contact_id) DO NOTHING`,
          values: [segment.id, row.id],
        })
      }

      await dispatch(teamId, "contact.created", { contact_id: row.id, email: row.email })
      return json(c, 201, { object: "contact", id: row.id })
    },
  ),

  getR(
    "/contacts",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const q = (c.query ?? {}) as Record<string, string>

      // `segment_id` narrows the list to one segment's membership.
      const page = q.segment_id
        ? await paginate<Contact>({
            table: "contacts",
            teamId,
            query: parsePageQuery(q),
            where: "id IN (SELECT contact_id FROM segment_contacts WHERE segment_id = $1)",
            values: [q.segment_id],
            alwaysPaginate: false,
          })
        : await paginate<Contact>({
            table: "contacts",
            teamId,
            query: parsePageQuery(q),
            alwaysPaginate: false,
          })

      const data = await Promise.all(
        page.data.map(async (row) => contactObject(row, await propertiesOf(teamId, row.id))),
      )
      return json(c, 200, { ...page, data })
    },
  ),

  getR(
    "/contacts/:id/topics",
    {
      params: idParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      const rows = await db().all<{
        id: string
        name: string
        description: string | null
        default_subscription: string
        subscription: string | null
        created_at: Date
      }>({
        text: `SELECT t.id, t.name, t.description, t.default_subscription, ct.subscription, t.created_at
               FROM topics t
               LEFT JOIN contact_topics ct ON ct.topic_id = t.id AND ct.contact_id = $2
               WHERE t.team_id = $1
               ORDER BY t.created_at DESC`,
        values: [teamId, contact.id],
      })
      return json(
        c,
        200,
        listEnvelope(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            description: r.description,
            subscription: r.subscription ?? r.default_subscription,
            created_at: pgTimestamp(r.created_at),
          })),
        ),
      )
    },
  ),

  patchR(
    "/contacts/:id/topics",
    {
      params: idParam,
      body: z.object({ topics: z.array(topicSubscription).min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      await writeTopics(contact.id, c.body.topics)
      await dispatch(teamId, "contact.updated", { contact_id: contact.id, email: contact.email })
      return json(c, 200, { object: "contact", id: contact.id })
    },
  ),

  getR(
    "/contacts/:id/segments",
    {
      params: idParam,
      query: z.record(z.string()).optional(),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      const rows = await db().all<Segment>({
        text: `SELECT s.* FROM segments s
               JOIN segment_contacts sc ON sc.segment_id = s.id
               WHERE sc.contact_id = $1 AND s.team_id = $2
               ORDER BY s.created_at DESC`,
        values: [contact.id, teamId],
      })
      return json(c, 200, listEnvelope(rows.map(segmentObject)))
    },
  ),

  postR(
    "/contacts/:id/segments/:segment_id",
    {
      params: z.object({ id: z.string().min(1), segment_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      const segment = await db().one<Segment>(
        from(segments).where((q) => [
          q("id").equals(c.params.segment_id),
          q("team_id").equals(teamId),
        ]),
      )
      if (!segment) throw notFound("Segment not found")
      await db().execute({
        text: `INSERT INTO segment_contacts (segment_id, contact_id) VALUES ($1, $2)
               ON CONFLICT (segment_id, contact_id) DO NOTHING`,
        values: [segment.id, contact.id],
      })
      return json(c, 201, { object: "contact", id: contact.id, segment_id: segment.id })
    },
  ),

  delR(
    "/contacts/:id/segments/:segment_id",
    {
      params: z.object({ id: z.string().min(1), segment_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      await db().execute(
        from(segmentContacts)
          .where((q) => [
            q("segment_id").equals(c.params.segment_id),
            q("contact_id").equals(contact.id),
          ])
          .del(),
      )
      return json(c, 200, { object: "contact", id: contact.id, deleted: true })
    },
  ),

  getR(
    "/contacts/:id",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      return json(c, 200, contactObject(contact, await propertiesOf(teamId, contact.id)))
    },
  ),

  patchR(
    "/contacts/:id",
    {
      params: idParam,
      body: z.object({
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        unsubscribed: z.boolean().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.first_name !== undefined) patch.first_name = c.body.first_name
      if (c.body.last_name !== undefined) patch.last_name = c.body.last_name
      if (c.body.unsubscribed !== undefined) {
        patch.unsubscribed = c.body.unsubscribed
        patch.unsubscribed_at = c.body.unsubscribed ? new Date() : null
      }

      await db().execute(
        from(contacts)
          .where((q) => [q("id").equals(contact.id), q("team_id").equals(teamId)])
          .update(patch),
      )
      if (c.body.properties) await writeProperties(teamId, contact.id, c.body.properties)

      await dispatch(teamId, "contact.updated", { contact_id: contact.id, email: contact.email })
      return json(c, 200, { object: "contact", id: contact.id })
    },
  ),

  delR(
    "/contacts/:id",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      await db().execute(
        from(contacts)
          .where((q) => [q("id").equals(contact.id), q("team_id").equals(teamId)])
          .del(),
      )
      await dispatch(teamId, "contact.deleted", { contact_id: contact.id, email: contact.email })
      return json(c, 200, { object: "contact", id: contact.id, deleted: true })
    },
  ),
]

/**
 * Audience-scoped contact routes.
 *
 * Before Segments, contacts hung off an audience, and the official SDK still
 * posts to `/audiences/{id}/contacts` when given an `audience_id`. These
 * delegate to the same records so both call styles reach one contact table.
 */
const audienceScoped = (base: "audiences" | "segments"): Route[] => [
  postR(
    `/${base}/:segment_id/contacts`,
    {
      params: z.object({ segment_id: z.string().uuid() }),
      body: z.object({
        email: z.string().email(),
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        unsubscribed: z.boolean().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const email = normalizeEmail(c.body.email)

      const segment = await db().one<Segment>(
        from(segments).where((q) => [
          q("id").equals(c.params.segment_id),
          q("team_id").equals(teamId),
        ]),
      )
      if (!segment) throw notFound("Segment not found")

      // Re-adding an existing contact to an audience is an upsert, not a clash.
      const existing = await db().one<Contact>(
        from(contacts).where((q) => [q("team_id").equals(teamId), q("email").equals(email)]),
      )
      const row =
        existing ??
        (await db().one<Contact>(
          from(contacts)
            .insert({
              team_id: teamId,
              email,
              first_name: c.body.first_name ?? null,
              last_name: c.body.last_name ?? null,
              unsubscribed: c.body.unsubscribed ?? false,
              unsubscribed_at: c.body.unsubscribed ? new Date() : null,
            })
            .returning(...allColumns(contacts)),
        ))!

      if (c.body.properties) await writeProperties(teamId, row.id, c.body.properties)
      await db().execute({
        text: `INSERT INTO segment_contacts (segment_id, contact_id) VALUES ($1, $2)
               ON CONFLICT (segment_id, contact_id) DO NOTHING`,
        values: [segment.id, row.id],
      })

      if (!existing) {
        await dispatch(teamId, "contact.created", { contact_id: row.id, email: row.email })
      }
      return json(c, 201, { object: "contact", id: row.id })
    },
  ),

  getR(
    `/${base}/:segment_id/contacts/:id`,
    {
      params: z.object({ segment_id: z.string().uuid(), id: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      return json(c, 200, contactObject(contact, await propertiesOf(teamId, contact.id)))
    },
  ),

  patchR(
    `/${base}/:segment_id/contacts/:id`,
    {
      params: z.object({ segment_id: z.string().uuid(), id: z.string().min(1) }),
      body: z.object({
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        unsubscribed: z.boolean().optional(),
        properties: z.record(z.unknown()).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.first_name !== undefined) patch.first_name = c.body.first_name
      if (c.body.last_name !== undefined) patch.last_name = c.body.last_name
      if (c.body.unsubscribed !== undefined) {
        patch.unsubscribed = c.body.unsubscribed
        patch.unsubscribed_at = c.body.unsubscribed ? new Date() : null
      }
      await db().execute(
        from(contacts)
          .where((q) => [q("id").equals(contact.id), q("team_id").equals(teamId)])
          .update(patch),
      )
      if (c.body.properties) await writeProperties(teamId, contact.id, c.body.properties)

      await dispatch(teamId, "contact.updated", { contact_id: contact.id, email: contact.email })
      return json(c, 200, { object: "contact", id: contact.id })
    },
  ),

  delR(
    `/${base}/:segment_id/contacts/:id`,
    {
      params: z.object({ segment_id: z.string().uuid(), id: z.string().min(1) }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const contact = await findContact(teamId, c.params.id)
      await db().execute(
        from(contacts)
          .where((q) => [q("id").equals(contact.id), q("team_id").equals(teamId)])
          .del(),
      )
      await dispatch(teamId, "contact.deleted", { contact_id: contact.id, email: contact.email })
      return json(c, 200, { object: "contact", id: contact.id, deleted: true })
    },
  ),
]

export const audienceContactRoutes: Route[] = [
  ...audienceScoped("audiences"),
  ...audienceScoped("segments"),
]

export const contactPropertyRoutes: Route[] = [
  postR(
    "/contact-properties",
    {
      body: z.object({
        key: z
          .string()
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Keys must be alphanumeric with underscores"),
        type: z.enum(["string", "number"]),
        fallback_value: z.union([z.string(), z.number()]).nullish(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = (await db().one<ContactProperty>(
        from(contactProperties)
          .insert({
            team_id: teamId,
            key: c.body.key,
            type: c.body.type,
            fallback_value:
              c.body.fallback_value === null || c.body.fallback_value === undefined
                ? null
                : String(c.body.fallback_value),
          })
          .returning(...allColumns(contactProperties)),
      ))!
      return json(c, 201, { object: "contact_property", id: row.id })
    },
  ),

  getR(
    "/contact-properties",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<ContactProperty>({
        table: "contact_properties",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
        alwaysPaginate: false,
      })
      return json(c, 200, { ...page, data: page.data.map(contactPropertyObject) })
    },
  ),

  getR(
    "/contact-properties/:contact_property_id",
    {
      params: z.object({ contact_property_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<ContactProperty>(
        from(contactProperties).where((q) => [
          q("id").equals(c.params.contact_property_id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Contact property not found")
      return json(c, 200, contactPropertyObject(row))
    },
  ),

  patchR(
    "/contact-properties/:contact_property_id",
    {
      params: z.object({ contact_property_id: z.string().uuid() }),
      body: z.object({ fallback_value: z.union([z.string(), z.number()]).nullish() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const row = await db().one<ContactProperty>(
        from(contactProperties).where((q) => [
          q("id").equals(c.params.contact_property_id),
          q("team_id").equals(teamId),
        ]),
      )
      if (!row) throw notFound("Contact property not found")
      await db().execute(
        from(contactProperties)
          .where((q) => q("id").equals(row.id))
          .update({
            fallback_value:
              c.body.fallback_value === null || c.body.fallback_value === undefined
                ? null
                : String(c.body.fallback_value),
            updated_at: new Date(),
          }),
      )
      return json(c, 200, { object: "contact_property", id: row.id })
    },
  ),

  delR(
    "/contact-properties/:contact_property_id",
    {
      params: z.object({ contact_property_id: z.string().uuid() }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      await db().execute(
        from(contactProperties)
          .where((q) => [q("id").equals(c.params.contact_property_id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, {
        object: "contact_property",
        id: c.params.contact_property_id,
        deleted: true,
      })
    },
  ),
]

export const topicRoutes: Route[] = [
  postR(
    "/topics",
    {
      body: z.object({
        name: z.string().min(1),
        default_subscription: z.enum(["opt_in", "opt_out"]),
        description: z.string().nullish(),
        visibility: z.enum(["public", "private"]).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const row = (await db().one<Topic>(
        from(topics)
          .insert({
            team_id: authOf(c).teamId,
            name: c.body.name,
            description: c.body.description ?? null,
            default_subscription: c.body.default_subscription,
            visibility: c.body.visibility ?? "public",
          })
          .returning(...allColumns(topics)),
      ))!
      return json(c, 201, { object: "topic", id: row.id })
    },
  ),

  getR(
    "/topics",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Topic>({
        table: "topics",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      return json(c, 200, { ...page, data: page.data.map(topicObject) })
    },
  ),

  getR(
    "/topics/:topic_id",
    { params: z.object({ topic_id: z.string().uuid() }), before: authedFull, assigns: {} as never },
    async (c) => {
      const row = await db().one<Topic>(
        from(topics).where((q) => [
          q("id").equals(c.params.topic_id),
          q("team_id").equals(authOf(c).teamId),
        ]),
      )
      if (!row) throw notFound("Topic not found")
      return json(c, 200, topicObject(row))
    },
  ),

  patchR(
    "/topics/:topic_id",
    {
      params: z.object({ topic_id: z.string().uuid() }),
      body: z.object({
        name: z.string().optional(),
        description: z.string().nullish(),
        visibility: z.enum(["public", "private"]).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.description !== undefined) patch.description = c.body.description
      if (c.body.visibility !== undefined) patch.visibility = c.body.visibility

      const row = await db().one(
        from(topics)
          .where((q) => [q("id").equals(c.params.topic_id), q("team_id").equals(teamId)])
          .update(patch)
          .returning("id"),
      )
      if (!row) throw notFound("Topic not found")
      return json(c, 200, { object: "topic", id: c.params.topic_id })
    },
  ),

  delR(
    "/topics/:topic_id",
    { params: z.object({ topic_id: z.string().uuid() }), before: authedFull, assigns: {} as never },
    async (c) => {
      await db().execute(
        from(topics)
          .where((q) => [q("id").equals(c.params.topic_id), q("team_id").equals(authOf(c).teamId)])
          .del(),
      )
      return json(c, 200, { object: "topic", id: c.params.topic_id, deleted: true })
    },
  ),
]
