import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// provider: inkling | …   status: connected | error
export const integrations = defineSchema("integrations", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  provider: column.text(),
  name: column.text().nullable(),
  base_url: column.text(),
  api_key: column.text(),
  settings: column.json<Record<string, unknown>>().nullable(),
  status: column.text().default("connected"),
  last_error: column.text().nullable(),
  last_checked_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

export type Integration = RowOf<typeof integrations>
