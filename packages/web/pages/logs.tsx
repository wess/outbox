import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Badge,
  Card,
  Empty,
  formatDate,
  Icon,
  icons,
  Loading,
  PageHead,
  Pager,
  relativeTime,
} from "../components/index.tsx"
import { type List, qs } from "../lib/api.ts"
import { useResource } from "../lib/hooks.ts"

type LogRow = {
  id: string
  created_at: string
  endpoint: string
  method: string
  response_status: number
  user_agent: string | null
}

type LogDetail = LogRow & { request_body: unknown; response_body: unknown }

const statusTone = (status: number): string =>
  status < 300 ? "ok" : status < 400 ? "info" : status < 500 ? "warn" : "bad"

const Json = ({ value }: { value: unknown }) => (
  <pre
    className="mono"
    style={{
      margin: 0,
      padding: 14,
      background: "var(--bg-raised)",
      borderRadius: 8,
      overflowX: "auto",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    }}
  >
    {value === null || value === undefined ? "null" : JSON.stringify(value, null, 2)}
  </pre>
)

const LogDetailView = ({ id }: { id: string }) => {
  const { data, loading } = useResource<LogDetail>(`/logs/${id}`)
  if (loading) return <Loading />
  if (!data)
    return <Empty emoji="📄" title="Log not found" description="Logs are pruned over time." />

  return (
    <>
      <PageHead
        title={`${data.method} ${data.endpoint}`}
        actions={
          <button type="button" className="btn" onClick={() => navigate("/logs")}>
            <Icon path={icons.back} size={14} /> Back
          </button>
        }
      />
      <div className="stack">
        <Card pad>
          <div className="grid-2">
            <div>
              <div className="dim">Status</div>
              <Badge value={String(data.response_status)} tone={statusTone(data.response_status)} />
            </div>
            <div>
              <div className="dim">When</div>
              <div>{formatDate(data.created_at)}</div>
            </div>
            <div>
              <div className="dim">User agent</div>
              <div className="truncate">{data.user_agent ?? "—"}</div>
            </div>
          </div>
        </Card>
        <Card pad>
          <h2>Request body</h2>
          <Json value={data.request_body} />
        </Card>
        <Card pad>
          <h2>Response body</h2>
          <Json value={data.response_body} />
        </Card>
      </div>
    </>
  )
}

export const LogsPage = ({ route = "/logs" }: { route?: string }) => {
  const detailId = route.startsWith("/logs/") ? route.slice("/logs/".length) : null
  const [cursors, setCursors] = useState<string[]>([])
  const [method, setMethod] = useState("")
  const after = cursors[cursors.length - 1]
  const { data, loading } = useResource<List<LogRow>>(
    detailId ? null : `/logs${qs({ limit: 30, after })}`,
  )

  if (detailId) return <LogDetailView id={detailId} />

  const rows = (data?.data ?? []).filter((r) => !method || r.method === method)

  return (
    <>
      <PageHead title="Logs" />

      <div className="filters">
        <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">All methods</option>
          {["GET", "POST", "PATCH", "DELETE"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <Card>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            emoji="📋"
            title="No API requests yet"
            description="Every call to the Outbox API is recorded here with its request and response."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>User agent</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    onClick={() => navigate(`/logs/${row.id}`)}
                  >
                    <td>
                      <span className="badge plain">{row.method}</span>
                    </td>
                    <td className="mono truncate">{row.endpoint}</td>
                    <td>
                      <Badge
                        value={String(row.response_status)}
                        tone={statusTone(row.response_status)}
                      />
                    </td>
                    <td className="truncate muted">{row.user_agent ?? "—"}</td>
                    <td className="muted">{relativeTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Pager
        hasMore={Boolean(data?.has_more)}
        onNext={() => {
          const last = data?.data[data.data.length - 1]
          if (last) setCursors([...cursors, last.id])
        }}
        onPrev={() => setCursors(cursors.slice(0, -1))}
        canPrev={cursors.length > 0}
      />
    </>
  )
}
