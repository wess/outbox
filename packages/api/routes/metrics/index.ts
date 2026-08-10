import { invalidParameter } from "@outbox/core"
import { db } from "@outbox/core/db"
import { anyOf, jsonArray } from "@outbox/core/pagination"
import { getR, json, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { authedFull, authOf } from "../../pipes/index.ts"

const GRANULARITY: Record<string, string> = {
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
}

// Countable events plus the rates derived from them.
const COUNT_METRICS = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "delivery_delayed",
  "failed",
  "canceled",
  "suppressed",
] as const

const RATE_METRICS = [
  "delivery_rate",
  "open_rate",
  "click_rate",
  "bounce_rate",
  "complaint_rate",
] as const

const ALL_METRICS = [...COUNT_METRICS, ...RATE_METRICS] as const
type Metric = (typeof ALL_METRICS)[number]

const DIMENSIONS = ["period", "domain", "email", "tag"] as const
type Dimension = (typeof DIMENSIONS)[number]

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 100

type Bucket = {
  key: string
  period?: string
  domain?: string
  email_id?: string
  counts: Record<string, number>
}

export const metricsRoutes: Route[] = [
  getR(
    "/emails/metrics",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const q = (c.query ?? {}) as Record<string, string>

      const granularity = q.granularity ?? "daily"
      const trunc = GRANULARITY[granularity]
      if (!trunc) {
        throw invalidParameter("`granularity` must be one of hourly, daily, weekly, monthly.")
      }

      const requested = csv(q.metrics)
      const metrics: Metric[] = requested.length
        ? (requested.filter((m) => (ALL_METRICS as readonly string[]).includes(m)) as Metric[])
        : ["sent", "delivered", "opened", "clicked", "bounced"]
      if (requested.length && metrics.length !== requested.length) {
        throw invalidParameter(`\`metrics\` must be a subset of: ${ALL_METRICS.join(", ")}.`)
      }

      const dimensions = csv(q.dimensions).filter((d) =>
        (DIMENSIONS as readonly string[]).includes(d),
      ) as Dimension[]

      const end = q.end_date ? new Date(q.end_date) : new Date()
      const start = q.start_date ? new Date(q.start_date) : new Date(end.getTime() - 29 * 86400_000)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw invalidParameter("`start_date` and `end_date` must be valid dates.")
      }

      const timezone = q.timezone ?? "UTC"
      const domainIds = csv(q.domain_id)
      const emailIds = csv(q.email_id)

      const params: unknown[] = [teamId, start, end]
      const filters = ["e.team_id = $1", "ev.created_at >= $2", "ev.created_at <= $3"]
      if (domainIds.length) {
        params.push(jsonArray(domainIds))
        filters.push(`e.domain_id = ANY(${anyOf(params.length, "uuid")})`)
      }
      if (emailIds.length) {
        params.push(jsonArray(emailIds))
        filters.push(`e.id = ANY(${anyOf(params.length, "uuid")})`)
      }

      const groupCols: string[] = []
      const selectCols: string[] = []
      if (dimensions.includes("period")) {
        // Bound only when referenced — an unused parameter has no inferable type.
        params.push(timezone)
        selectCols.push(
          `date_trunc('${trunc}', ev.created_at AT TIME ZONE $${params.length}::text) AS period`,
        )
        groupCols.push("period")
      }
      if (dimensions.includes("domain")) {
        selectCols.push("d.name AS domain")
        groupCols.push("domain")
      }
      if (dimensions.includes("email")) {
        selectCols.push("e.id::text AS email_id")
        groupCols.push("email_id")
      }

      const sql = `
        SELECT ${selectCols.length ? `${selectCols.join(", ")},` : ""}
               ev.type AS type,
               count(DISTINCT ev.email_id) AS total
        FROM email_events ev
        JOIN emails e ON e.id = ev.email_id
        LEFT JOIN domains d ON d.id = e.domain_id
        WHERE ${filters.join(" AND ")}
        GROUP BY ${[...groupCols, "ev.type"].join(", ")}
        ORDER BY ${groupCols.length ? `${groupCols[0]} ASC` : "ev.type"}`

      const rows = await db().all<{
        period?: Date
        domain?: string | null
        email_id?: string
        type: string
        total: string
      }>({ text: sql, values: params })

      const buckets = new Map<string, Bucket>()
      for (const row of rows) {
        const period = row.period ? new Date(row.period).toISOString() : undefined
        const key = [period, row.domain, row.email_id].filter(Boolean).join("|") || "all"
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = {
            key,
            ...(period ? { period } : {}),
            ...(row.domain !== undefined ? { domain: row.domain ?? "" } : {}),
            ...(row.email_id ? { email_id: row.email_id } : {}),
            counts: {},
          }
          buckets.set(key, bucket)
        }
        bucket.counts[row.type.replace(/^email\./, "")] = Number(row.total)
      }

      const shape = (bucket: Bucket) => {
        const counts = bucket.counts
        const sent = counts.sent ?? 0
        const delivered = counts.delivered ?? 0
        const out: Record<string, unknown> = {}
        if (bucket.period !== undefined) out.period = bucket.period
        if (bucket.domain !== undefined) out.domain = bucket.domain
        if (bucket.email_id !== undefined) out.email_id = bucket.email_id
        for (const metric of metrics) {
          if ((COUNT_METRICS as readonly string[]).includes(metric)) {
            out[metric] = counts[metric] ?? 0
            continue
          }
          if (metric === "delivery_rate") out[metric] = rate(delivered, sent)
          if (metric === "open_rate") out[metric] = rate(counts.opened ?? 0, delivered)
          if (metric === "click_rate") out[metric] = rate(counts.clicked ?? 0, delivered)
          if (metric === "bounce_rate") out[metric] = rate(counts.bounced ?? 0, sent)
          if (metric === "complaint_rate") out[metric] = rate(counts.complained ?? 0, delivered)
        }
        return out
      }

      let data = [...buckets.values()].map(shape)

      if (q.sort_by && data.length) {
        const key = q.sort_by
        const dir = q.sort_order === "asc" ? 1 : -1
        data = [...data].sort((a, b) => {
          const av = a[key]
          const bv = b[key]
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir
          return String(av ?? "").localeCompare(String(bv ?? "")) * dir
        })
      }

      return json(c, 200, {
        object: "list",
        data,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        granularity,
      })
    },
  ),

  getR(
    "/segments/metrics",
    { query: z.record(z.string()).optional(), before: authedFull, assigns: {} as never },
    async (c) => {
      const teamId = authOf(c).teamId
      const q = (c.query ?? {}) as Record<string, string>
      const segmentIds = csv(q.segment_id)

      const params: unknown[] = [teamId]
      let filter = "s.team_id = $1"
      if (segmentIds.length) {
        params.push(jsonArray(segmentIds))
        filter += ` AND s.id = ANY(${anyOf(params.length, "uuid")})`
      }

      const rows = await db().all<{
        segment_id: string
        name: string
        all_contacts: string
        subscribed_contacts: string
        unsubscribed_contacts: string
      }>({
        text: `
          SELECT s.id::text AS segment_id,
                 s.name AS name,
                 count(sc.contact_id) AS all_contacts,
                 count(sc.contact_id) FILTER (WHERE c.unsubscribed = false) AS subscribed_contacts,
                 count(sc.contact_id) FILTER (WHERE c.unsubscribed = true) AS unsubscribed_contacts
          FROM segments s
          LEFT JOIN segment_contacts sc ON sc.segment_id = s.id
          LEFT JOIN contacts c ON c.id = sc.contact_id
          WHERE ${filter}
          GROUP BY s.id, s.name
          ORDER BY s.name`,
        values: params,
      })

      return json(c, 200, {
        object: "list",
        data: rows.map((r) => ({
          segment_id: r.segment_id,
          name: r.name,
          all_contacts: Number(r.all_contacts),
          subscribed_contacts: Number(r.subscribed_contacts),
          unsubscribed_contacts: Number(r.unsubscribed_contacts),
        })),
      })
    },
  ),
]
