import { invalidParameter, notFound, paginate, parsePageQuery, templateObject } from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import {
  type Template,
  type TemplateVariable,
  type TemplateVersion,
  templates,
  templateVariables,
  templateVersions,
} from "@outbox/schema"
import { from } from "@wess/atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_VARIABLES = 50

const variableSchema = z.object({
  key: z.string().min(1),
  type: z.enum(["string", "number"]),
  fallback_value: z.union([z.string(), z.number()]).nullish(),
})

// Templates are addressable by id or alias.
const findTemplate = async (teamId: string, idOrAlias: string): Promise<Template> => {
  const row = await db().one<Template>(
    from(templates).where((q) =>
      UUID.test(idOrAlias)
        ? [q("id").equals(idOrAlias), q("team_id").equals(teamId)]
        : [q("alias").equals(idOrAlias), q("team_id").equals(teamId)],
    ),
  )
  if (!row) throw notFound("Template not found")
  return row
}

const latestVersion = (templateId: string): Promise<TemplateVersion | null> =>
  db().one<TemplateVersion>({
    text: "SELECT * FROM template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1",
    values: [templateId],
  })

const versionById = (id: string): Promise<TemplateVersion | null> =>
  db().one<TemplateVersion>(from(templateVersions).where((q) => q("id").equals(id)))

const variablesOf = (versionId: string): Promise<TemplateVariable[]> =>
  db().all<TemplateVariable>(
    from(templateVariables).where((q) => q("template_version_id").equals(versionId)),
  )

const writeVariables = async (
  templateId: string,
  versionId: string,
  vars: z.infer<typeof variableSchema>[],
): Promise<void> => {
  if (vars.length > MAX_VARIABLES) {
    throw invalidParameter(`A template may declare at most ${MAX_VARIABLES} variables.`)
  }
  if (vars.length === 0) return
  await db().execute(
    from(templateVariables).insertMany(
      vars.map((v) => ({
        template_version_id: versionId,
        template_id: templateId,
        key: v.key,
        type: v.type,
        fallback_value:
          v.fallback_value === null || v.fallback_value === undefined
            ? null
            : String(v.fallback_value),
      })),
    ),
  )
}

// Every edit lands in a new draft version; publishing promotes one to current.
const createVersion = async (input: {
  teamId: string
  templateId: string
  from?: string | null
  subject?: string | null
  reply_to?: string[] | null
  html?: string | null
  text?: string | null
  variables?: z.infer<typeof variableSchema>[]
}): Promise<TemplateVersion> => {
  const previous = await latestVersion(input.templateId)
  const version = (previous?.version ?? 0) + 1
  const row = (await db().one<TemplateVersion>(
    from(templateVersions)
      .insert({
        template_id: input.templateId,
        team_id: input.teamId,
        version,
        from_address: input.from ?? previous?.from_address ?? null,
        subject: input.subject ?? previous?.subject ?? null,
        reply_to: input.reply_to ?? previous?.reply_to ?? null,
        html: input.html ?? previous?.html ?? null,
        text: input.text ?? previous?.text ?? null,
      })
      .returning(...allColumns(templateVersions)),
  ))!
  await writeVariables(input.templateId, row.id, input.variables ?? [])
  return row
}

const hasUnpublished = async (template: Template): Promise<boolean> => {
  const latest = await latestVersion(template.id)
  return Boolean(latest && latest.id !== template.current_version_id)
}

const serialize = async (template: Template) => {
  const version = template.current_version_id
    ? await versionById(template.current_version_id)
    : await latestVersion(template.id)
  const vars = version ? await variablesOf(version.id) : []
  return templateObject(template, version, vars, await hasUnpublished(template))
}

const idParam = z.object({ id: z.string().min(1) })

export const templateRoutes: Route[] = [
  postR(
    "/templates",
    {
      body: z.object({
        name: z.string().min(1),
        html: z.string(),
        alias: z.string().optional(),
        from: z.string().optional(),
        subject: z.string().optional(),
        reply_to: z.union([z.string(), z.array(z.string())]).optional(),
        text: z.string().optional(),
        variables: z.array(variableSchema).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const template = (await db().one<Template>(
        from(templates)
          .insert({ team_id: teamId, name: c.body.name, alias: c.body.alias ?? null })
          .returning(...allColumns(templates)),
      ))!

      const replyTo = c.body.reply_to
        ? Array.isArray(c.body.reply_to)
          ? c.body.reply_to
          : [c.body.reply_to]
        : null

      await createVersion({
        teamId,
        templateId: template.id,
        from: c.body.from ?? null,
        subject: c.body.subject ?? null,
        reply_to: replyTo,
        html: c.body.html,
        text: c.body.text ?? null,
        variables: c.body.variables,
      })

      return json(c, 201, { object: "template", id: template.id })
    },
  ),

  getR(
    "/templates",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const page = await paginate<Template>({
        table: "templates",
        teamId: authOf(c).teamId,
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      const data = await Promise.all(page.data.map(serialize))
      return json(c, 200, { ...page, data })
    },
  ),

  postR(
    "/templates/:id/publish",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const template = await findTemplate(teamId, c.params.id)
      const latest = await latestVersion(template.id)
      if (!latest) throw invalidParameter("Template has no versions to publish.")

      const now = new Date()
      await db().execute(
        from(templateVersions)
          .where((q) => q("id").equals(latest.id))
          .update({ published_at: now }),
      )
      await db().execute(
        from(templates)
          .where((q) => q("id").equals(template.id))
          .update({
            current_version_id: latest.id,
            status: "published",
            published_at: now,
            updated_at: now,
          }),
      )
      return json(c, 200, { object: "template", id: template.id, current_version_id: latest.id })
    },
  ),

  postR(
    "/templates/:id/duplicate",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const template = await findTemplate(teamId, c.params.id)
      const source = template.current_version_id
        ? await versionById(template.current_version_id)
        : await latestVersion(template.id)

      const copy = (await db().one<Template>(
        from(templates)
          .insert({ team_id: teamId, name: `${template.name} (copy)`, alias: null })
          .returning(...allColumns(templates)),
      ))!

      const vars = source ? await variablesOf(source.id) : []
      await createVersion({
        teamId,
        templateId: copy.id,
        from: source?.from_address ?? null,
        subject: source?.subject ?? null,
        reply_to: source?.reply_to ?? null,
        html: source?.html ?? null,
        text: source?.text ?? null,
        variables: vars.map((v) => ({
          key: v.key,
          type: v.type as "string" | "number",
          fallback_value: v.fallback_value,
        })),
      })

      return json(c, 201, { object: "template", id: copy.id })
    },
  ),

  getR(
    "/templates/:id",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const template = await findTemplate(authOf(c).teamId, c.params.id)
      return json(c, 200, await serialize(template))
    },
  ),

  patchR(
    "/templates/:id",
    {
      params: idParam,
      body: z.object({
        name: z.string().optional(),
        html: z.string().optional(),
        alias: z.string().nullish(),
        from: z.string().optional(),
        subject: z.string().optional(),
        reply_to: z.union([z.string(), z.array(z.string())]).optional(),
        text: z.string().optional(),
        variables: z.array(variableSchema).optional(),
      }),
      before: authedFull,
      assigns: {} as never,
    },
    async (c) => {
      const teamId = authOf(c).teamId
      const template = await findTemplate(teamId, c.params.id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.alias !== undefined) patch.alias = c.body.alias
      if (Object.keys(patch).length > 1) {
        await db().execute(
          from(templates)
            .where((q) => q("id").equals(template.id))
            .update(patch),
        )
      }

      const touchesContent =
        c.body.html !== undefined ||
        c.body.text !== undefined ||
        c.body.subject !== undefined ||
        c.body.from !== undefined ||
        c.body.reply_to !== undefined ||
        c.body.variables !== undefined

      if (touchesContent) {
        const replyTo = c.body.reply_to
          ? Array.isArray(c.body.reply_to)
            ? c.body.reply_to
            : [c.body.reply_to]
          : null
        await createVersion({
          teamId,
          templateId: template.id,
          from: c.body.from ?? null,
          subject: c.body.subject ?? null,
          reply_to: replyTo,
          html: c.body.html ?? null,
          text: c.body.text ?? null,
          variables: c.body.variables,
        })
      }

      return json(c, 200, { object: "template", id: template.id })
    },
  ),

  delR(
    "/templates/:id",
    { params: idParam, before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const template = await findTemplate(teamId, c.params.id)
      await db().execute(
        from(templates)
          .where((q) => [q("id").equals(template.id), q("team_id").equals(teamId)])
          .del(),
      )
      return json(c, 200, { object: "template", id: template.id, deleted: true })
    },
  ),
]
