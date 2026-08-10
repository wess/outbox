import { useMemo, useState } from "react"
import { Card, Loading, PageHead } from "../components/index.tsx"
import { qs } from "../lib/api.ts"
import { useResource } from "../lib/hooks.ts"

type Bucket = Record<string, string | number> & { period?: string }
type MetricsResponse = { object: "list"; data: Bucket[]; granularity: string }
type Summary = {
  emails: number
  delivered: number
  failed: number
  contacts: number
  domains: number
  verified_domains: number
  broadcasts: number
  queued_jobs: number
}

const SERIES = [
  { key: "delivered", label: "Delivered", color: "#4ade80" },
  { key: "opened", label: "Opened", color: "#60a5fa" },
  { key: "clicked", label: "Clicked", color: "#c084fc" },
  { key: "bounced", label: "Bounced", color: "#f87171" },
] as const

const RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 15 days", days: 15 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
]

const pct = (value: unknown): string =>
  typeof value === "number" ? `${value.toFixed(1)}%` : "0.0%"

export const MetricsPage = () => {
  const [days, setDays] = useState(15)
  const summary = useResource<Summary>("/dashboard/summary")

  const range = useMemo(() => {
    const end = new Date()
    const start = new Date(end.getTime() - (days - 1) * 86400_000)
    return { start: start.toISOString(), end: end.toISOString() }
  }, [days])

  const path = `/emails/metrics${qs({
    start_date: range.start,
    end_date: range.end,
    granularity: "daily",
    dimensions: "period",
    metrics:
      "sent,delivered,opened,clicked,bounced,complained,delivery_rate,open_rate,click_rate,bounce_rate",
  })}`
  const { data, loading } = useResource<MetricsResponse>(path)

  const buckets = useMemo(() => {
    const byDay = new Map<string, Bucket>()
    for (const b of data?.data ?? []) {
      if (!b.period) continue
      byDay.set(new Date(b.period).toISOString().slice(0, 10), b)
    }
    // Fill gaps so the chart shows a continuous timeline.
    const out: { day: string; bucket: Bucket }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
      out.push({ day, bucket: byDay.get(day) ?? {} })
    }
    return out
  }, [data, days])

  const max = useMemo(() => {
    let value = 0
    for (const { bucket } of buckets) {
      for (const s of SERIES) value = Math.max(value, Number(bucket[s.key] ?? 0))
    }
    return Math.max(value, 1)
  }, [buckets])

  const totals = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const { bucket } of buckets) {
      for (const key of ["sent", "delivered", "opened", "clicked", "bounced", "complained"]) {
        acc[key] = (acc[key] ?? 0) + Number(bucket[key] ?? 0)
      }
    }
    return acc
  }, [buckets])

  const rate = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100)

  return (
    <>
      <PageHead
        title="Metrics"
        actions={
          <select
            className="select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ width: "auto" }}
          >
            {RANGES.map((r) => (
              <option key={r.days} value={r.days}>
                {r.label}
              </option>
            ))}
          </select>
        }
      />

      <div className="stats">
        <div className="stat">
          <div className="stat-label">Emails</div>
          <div className="stat-value">{totals.sent ?? 0}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Delivery rate</div>
          <div className="stat-value">{pct(rate(totals.delivered ?? 0, totals.sent ?? 0))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open rate</div>
          <div className="stat-value">{pct(rate(totals.opened ?? 0, totals.delivered ?? 0))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Click rate</div>
          <div className="stat-value">{pct(rate(totals.clicked ?? 0, totals.delivered ?? 0))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Bounce rate</div>
          <div className="stat-value">{pct(rate(totals.bounced ?? 0, totals.sent ?? 0))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Complaint rate</div>
          <div className="stat-value">
            {pct(rate(totals.complained ?? 0, totals.delivered ?? 0))}
          </div>
        </div>
      </div>

      <Card pad>
        {loading ? (
          <Loading />
        ) : (
          <>
            <div className="bar-chart">
              {buckets.map(({ day, bucket }) => (
                <div className="bar-col" key={day} title={day}>
                  {SERIES.map((s) => {
                    const value = Number(bucket[s.key] ?? 0)
                    if (value === 0) return null
                    return (
                      <div
                        key={s.key}
                        className="bar"
                        style={{
                          height: `${(value / max) * 150}px`,
                          background: s.color,
                        }}
                        title={`${day} · ${s.label}: ${value}`}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="axis">
              <span>{buckets[0]?.day}</span>
              <span>{buckets[buckets.length - 1]?.day}</span>
            </div>
            <div className="legend">
              {SERIES.map((s) => (
                <div className="legend-item" key={s.key}>
                  <span className="legend-dot" style={{ background: s.color }} />
                  {s.label}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <div style={{ marginTop: 22 }}>
        <h2>Account</h2>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Contacts</div>
            <div className="stat-value">{summary.data?.contacts ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Verified domains</div>
            <div className="stat-value">
              {summary.data?.verified_domains ?? 0}
              <span className="dim" style={{ fontSize: 15 }}>
                {" "}
                / {summary.data?.domains ?? 0}
              </span>
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Broadcasts</div>
            <div className="stat-value">{summary.data?.broadcasts ?? 0}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Queued jobs</div>
            <div className="stat-value">{summary.data?.queued_jobs ?? 0}</div>
          </div>
        </div>
      </div>
    </>
  )
}
