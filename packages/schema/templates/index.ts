import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// status: draft | published
export const templates = defineSchema("templates", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  alias: column.text().nullable(),
  current_version_id: column.uuid().nullable(),
  status: column.text().default("draft"),
  published_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

export const templateVersions = defineSchema("template_versions", {
  id: id(),
  template_id: column.uuid().ref("templates", "id"),
  team_id: column.uuid(),
  version: column.integer().default(1),
  from_address: column.text().nullable(),
  subject: column.text().nullable(),
  reply_to: column.json<string[]>().nullable(),
  html: column.text().nullable(),
  text: column.text().nullable(),
  published_at: column.timestamp().nullable(),
  created_by: column.uuid().nullable(),
  created_at: now(),
})

// type: string | number
export const templateVariables = defineSchema("template_variables", {
  id: id(),
  template_version_id: column.uuid().ref("template_versions", "id"),
  template_id: column.uuid(),
  key: column.text(),
  type: column.text().default("string"),
  fallback_value: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

export type Template = RowOf<typeof templates>
export type TemplateVersion = RowOf<typeof templateVersions>
export type TemplateVariable = RowOf<typeof templateVariables>
