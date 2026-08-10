import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Badge,
  Card,
  Empty,
  Field,
  formatDate,
  Icon,
  icons,
  Loading,
  Modal,
  PageHead,
} from "../components/index.tsx"
import { del, type List, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

type BroadcastRow = {
  id: string
  segment_id: string | null
  status: string
  created_at: string
  scheduled_at: string | null
  sent_at: string | null
}

type Broadcast = BroadcastRow & {
  name: string | null
  from: string
  subject: string
  preview_text: string | null
  html: string | null
  text: string | null
  topic_id: string | null
}

type Metrics = {
  total: number
  sent: number
  remaining: number
  delivered: { count: number; percentage: number }
  opened: { count: number; percentage: number }
  clicked: { count: number; percentage: number }
  bounced: { count: number; percentage: number }
  complained: { count: number; percentage: number }
  clicked_links: { url: string; clicks: number; unique_clicks: number }[]
}

type Segment = { id: string; name: string }

const BroadcastDetailView = ({ id }: { id: string }) => {
  const broadcast = useResource<Broadcast>(`/broadcasts/${id}`)
  const metrics = useResource<Metrics>(`/broadcasts/${id}/metrics`)
  const { toast, show, fail } = useToast()
  const [scheduleAt, setScheduleAt] = useState("")

  if (broadcast.loading) return <Loading />
  if (!broadcast.data) {
    return <Empty emoji="📣" title="Broadcast not found" description="It may have been deleted." />
  }

  const data = broadcast.data
  const editable = data.status === "draft" || data.status === "scheduled"

  const send = async () => {
    try {
      await post(`/broadcasts/${id}/send`, scheduleAt ? { scheduled_at: scheduleAt } : {})
      show(scheduleAt ? "Broadcast scheduled" : "Broadcast sending")
      broadcast.reload()
      metrics.reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async () => {
    try {
      await del(`/broadcasts/${id}`)
      navigate("/broadcasts")
    } catch (err) {
      fail(err)
    }
  }

  const m = metrics.data

  return (
    <>
      <PageHead
        title={data.name ?? data.subject}
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate("/broadcasts")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            {editable ? (
              <button type="button" className="btn btn-primary" onClick={send}>
                {scheduleAt ? "Schedule" : "Send now"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-danger"
              onClick={remove}
              disabled={data.status === "sending"}
            >
              <Icon path={icons.trash} size={14} /> Delete
            </button>
          </>
        }
      />

      {m ? (
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Recipients</div>
            <div className="stat-value">{m.total}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Delivered</div>
            <div className="stat-value">{m.delivered.count}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Opened</div>
            <div className="stat-value">{m.opened.percentage}%</div>
          </div>
          <div className="stat">
            <div className="stat-label">Clicked</div>
            <div className="stat-value">{m.clicked.percentage}%</div>
          </div>
          <div className="stat">
            <div className="stat-label">Bounced</div>
            <div className="stat-value">{m.bounced.count}</div>
          </div>
        </div>
      ) : null}

      <div className="stack">
        <Card pad>
          <div className="grid-2">
            <div>
              <div className="dim">Status</div>
              <Badge value={data.status} />
            </div>
            <div>
              <div className="dim">From</div>
              <div>{data.from}</div>
            </div>
            <div>
              <div className="dim">Subject</div>
              <div>{data.subject}</div>
            </div>
            <div>
              <div className="dim">Sent</div>
              <div>{formatDate(data.sent_at)}</div>
            </div>
          </div>

          {editable ? (
            <div style={{ marginTop: 14 }}>
              <Field
                label="Schedule for later"
                hint="Leave empty to send immediately. Accepts `in 2 hours` or an ISO 8601 date."
              >
                <input
                  className="input"
                  placeholder="in 2 hours"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </Card>

        {m?.clicked_links?.length ? (
          <Card>
            <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <strong>Clicked links</strong>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Clicks</th>
                    <th>Unique</th>
                  </tr>
                </thead>
                <tbody>
                  {m.clicked_links.map((l) => (
                    <tr key={l.url}>
                      <td className="truncate mono">{l.url}</td>
                      <td>{l.clicks}</td>
                      <td>{l.unique_clicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {data.html ? (
          <Card>
            <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <strong>Preview</strong>
            </div>
            <iframe
              title="Broadcast preview"
              srcDoc={data.html}
              sandbox=""
              style={{ width: "100%", height: 400, border: "none", background: "#fff" }}
            />
          </Card>
        ) : null}
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const BroadcastsPage = ({ route = "/broadcasts" }: { route?: string }) => {
  const detailId = route.startsWith("/broadcasts/") ? route.slice("/broadcasts/".length) : null
  const { data, loading, reload } = useResource<List<BroadcastRow>>(detailId ? null : "/broadcasts")
  const segments = useResource<List<Segment>>(detailId ? null : "/segments")
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ segment_id: "", from: "", subject: "", html: "", name: "" })
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()

  if (detailId) return <BroadcastDetailView id={detailId} />

  const create = async () => {
    setBusy(true)
    try {
      const created = await post<{ id: string }>("/broadcasts", {
        segment_id: form.segment_id,
        from: form.from,
        subject: form.subject,
        html: form.html,
        name: form.name || undefined,
      })
      setCreating(false)
      setForm({ segment_id: "", from: "", subject: "", html: "", name: "" })
      reload()
      navigate(`/broadcasts/${created.id}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Broadcasts"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={14} /> Create broadcast
          </button>
        }
      />

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="📣"
            title="No broadcasts yet"
            description="Send a marketing email to everyone in a segment, personalised per contact."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create broadcast
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Broadcast</th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    onClick={() => navigate(`/broadcasts/${row.id}`)}
                  >
                    <td className="mono truncate">{row.id.slice(0, 8)}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td className="muted">{formatDate(row.scheduled_at)}</td>
                    <td className="muted">{formatDate(row.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <Modal
          title="Create broadcast"
          subtitle="Saved as a draft — you send it from the detail page."
          onClose={() => setCreating(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={create}
                disabled={busy || !form.segment_id || !form.from || !form.subject}
              >
                {busy ? "Creating…" : "Create draft"}
              </button>
            </>
          }
        >
          <Field label="Segment">
            <select
              className="select"
              value={form.segment_id}
              onChange={(e) => setForm({ ...form, segment_id: e.target.value })}
            >
              <option value="">Choose a segment…</option>
              {segments.data?.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name" hint="Internal label. Defaults to the subject.">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="From">
            <input
              className="input"
              placeholder="Acme <news@yourdomain.com>"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </Field>
          <Field label="Subject" hint="Personalise with {{{contact.first_name|there}}}.">
            <input
              className="input"
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </Field>
          <Field label="HTML">
            <textarea
              className="textarea"
              placeholder="<p>Hi {{{contact.first_name|there}}}</p>"
              value={form.html}
              onChange={(e) => setForm({ ...form, html: e.target.value })}
            />
          </Field>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
