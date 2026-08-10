import { config } from "@outbox/config"
import { type Connection, connect } from "@wess/atlas/db"

let shared: Connection | null = null

// One pool per process. Workers, the API, and the CLI all go through this.
export const db = (): Connection => {
  if (!shared)
    shared = connect({ driver: "postgres", url: config.databaseUrl, pool: config.dbPool })
  return shared
}

export const closeDb = async (): Promise<void> => {
  if (!shared) return
  await shared.close()
  shared = null
}

/**
 * Every column of a schema, for `.returning(...)`.
 *
 * @wess/atlas/db types `returning` over the schema's column keys and emits
 * nothing when given none, so there is no `RETURNING *`. Spreading the full key
 * list is the same SQL and keeps the row type intact.
 */
export const allColumns = <C extends Record<string, unknown>>(schema: {
  columns: C
}): (keyof C & string)[] => Object.keys(schema.columns) as (keyof C & string)[]

export type { Connection }
