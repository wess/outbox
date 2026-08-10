import { raw } from "@wess/atlas/db"
import { db } from "../db/index.ts"
import { invalidParameter } from "../errors/index.ts"

export type PageQuery = {
  limit?: number | undefined
  after?: string | undefined
  before?: string | undefined
}

export type Page<T> = { object: "list"; has_more: boolean; data: T[] }

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export const parsePageQuery = (q: Record<string, string | undefined>): PageQuery => {
  const { limit, after, before } = q
  if (after && before) {
    throw invalidParameter("You can only use either `after` or `before`, not both simultaneously.")
  }
  let parsed: number | undefined
  if (limit !== undefined && limit !== "") {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw invalidParameter(`\`limit\` must be an integer between 1 and ${MAX_LIMIT}.`)
    }
    parsed = n
  }
  return { limit: parsed, after, before }
}

// Cursors name a row by id. The seek compares (created_at, id) so rows sharing
// a timestamp still order deterministically.
const assertCursorExists = async (table: string, teamId: string | null, id: string) => {
  const conn = db()
  const where = teamId ? "id = $1 AND team_id = $2" : "id = $1"
  const values = teamId ? [id, teamId] : [id]
  const row = await conn.one<{ id: string }>({
    text: `SELECT id FROM ${table} WHERE ${where}`,
    values,
  })
  if (!row) throw invalidParameter("The provided pagination cursor does not exist.")
}

export type PaginateOptions = {
  table: string
  teamId?: string | null
  query: PageQuery
  // Extra predicates appended with AND. Use $N placeholders continuing from
  // `values.length`, or pass a builder that receives the next placeholder index.
  where?: string
  values?: unknown[]
  // Endpoints Resend documents as "optional limit" return everything when the
  // caller omits `limit`. Newer endpoints always paginate.
  alwaysPaginate?: boolean
  columns?: string
  order?: "asc" | "desc"
}

export const paginate = async <T>(opts: PaginateOptions): Promise<Page<T>> => {
  const {
    table,
    teamId = null,
    query,
    where,
    values = [],
    alwaysPaginate = true,
    columns = "*",
    order = "desc",
  } = opts

  const conn = db()
  const clauses: string[] = []
  const params: unknown[] = [...values]
  const next = () => `$${params.length + 1}`

  if (teamId) {
    clauses.push(`team_id = ${next()}`)
    params.push(teamId)
  }
  if (where) clauses.push(where)

  const desc = order === "desc"
  // `after` walks further along the sort order; `before` walks back against it.
  const cursorId = query.after ?? query.before
  const forward = query.after !== undefined

  let reversed = false
  if (cursorId) {
    await assertCursorExists(table, teamId, cursorId)
    const walkDesc = forward ? desc : !desc
    const cmp = walkDesc ? "<" : ">"
    const idParam = next()
    params.push(cursorId)
    // The anchor is read inside the query. Round-tripping created_at through a
    // JS Date truncates Postgres microseconds, which would leave the cursor row
    // itself inside the range.
    clauses.push(
      `(created_at, id) ${cmp} (SELECT created_at, id FROM ${table} WHERE id = ${idParam})`,
    )
    reversed = !forward
  }

  const effectiveDesc = reversed ? !desc : desc
  const dir = effectiveDesc ? "DESC" : "ASC"

  const unlimited = !alwaysPaginate && query.limit === undefined
  const limit = query.limit ?? DEFAULT_LIMIT
  const sql = [
    `SELECT ${columns} FROM ${table}`,
    clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    `ORDER BY created_at ${dir}, id ${dir}`,
    unlimited ? "" : `LIMIT ${limit + 1}`,
  ]
    .filter(Boolean)
    .join(" ")

  const rows = await conn.all<T>({ text: sql, values: params })
  const hasMore = !unlimited && rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows

  return { object: "list", has_more: hasMore, data: reversed ? data.reverse() : data }
}

export const listEnvelope = <T>(data: T[], hasMore = false): Page<T> => ({
  object: "list",
  has_more: hasMore,
  data,
})

export { raw }

/**
 * Bun's Postgres driver does not bind a JS array to a native Postgres array, so
 * `= ANY($1::uuid[])` fails. It *does* encode an array as JSON, so binding the
 * array itself and expanding it with `jsonb_array_elements_text` works for any
 * element type and keeps the query parameterised.
 *
 * Pass the array through unchanged — pre-stringifying it produces a jsonb
 * scalar ("[...]" as a string) and Postgres then refuses to expand it.
 *
 *   `email = ANY(${anyOf(1, "text")})`  with  values: [jsonArray(emails)]
 */
export const jsonArray = <T>(values: readonly T[]): readonly T[] => values

export const anyOf = (placeholder: number, cast: "text" | "uuid" = "text"): string =>
  `(SELECT jsonb_array_elements_text($${placeholder}::jsonb)::${cast})`
