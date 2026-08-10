import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Badge,
  Card,
  Copyable,
  Empty,
  Field,
  formatDate,
  Icon,
  icons,
  Loading,
  Modal,
  PageHead,
  relativeTime,
} from "../components/index.tsx"
import { del, type List, patch, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

const EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
]

type WebhookRow = {
  id: string
  endpoint: string
  events: string[]
  status: string
  signing_secret: string
  created_at: string
}

type EventRow = {
  id: string
  type: string
  created_at: string
  status: string
  next_attempt_at: string | null
}

type AttemptRow = {
  id: string
  http_status_code: number | null
  response: string | null
  sent_at: string
}

const WebhookDetailView = ({ id }: { id: string }) => {
  const hook = useResource<WebhookRow>(`/webhooks/${id}`)
  const events = useResource<List<EventRow>>(`/webhooks/${id}/events?limit=50`)
  const [openEvent, setOpenEvent] = useState<string | null>(null)
  const attempts = useResource<List<AttemptRow>>(
    openEvent ? `/webhooks/${id}/events/${openEvent}/attempts` : null,
  )
  const { toast, fail } = useToast()

  if (hook.loading) return <Loading />
  if (!hook.data)
    return <Empty emoji="🪝" title="Webhook not found" description="It may have been deleted." />

  const toggle = async () => {
    try {
      await patch(`/webhooks/${id}`, {
        status: hook.data!.status === "enabled" ? "disabled" : "enabled",
      })
      hook.reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async () => {
    try {
      await del(`/webhooks/${id}`)
      navigate("/webhooks")
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHead
        title="Webhook"
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate("/webhooks")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            <button type="button" className="btn" onClick={toggle}>
              {hook.data.status === "enabled" ? "Disable" : "Enable"}
            </button>
            <button type="button" className="btn btn-danger" onClick={remove}>
              <Icon path={icons.trash} size={14} /> Delete
            </button>
          </>
        }
      />

      <div className="stack">
        <Card pad>
          <div className="field">
            <div className="field-label">Endpoint</div>
            <div className="mono truncate">{hook.data.endpoint}</div>
          </div>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div>
              <div className="dim">Status</div>
              <Badge value={hook.data.status} />
            </div>
            <div>
              <div className="dim">Created</div>
              <div>{formatDate(hook.data.created_at)}</div>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Signing secret</div>
            <div className="row">
              <code style={{ wordBreak: "break-all", flex: 1 }}>{hook.data.signing_secret}</code>
              <Copyable value={hook.data.signing_secret} />
            </div>
            <div className="hint">
              Verify requests with the standard Svix libraries — Outbox signs with the same scheme.
            </div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label">Subscribed events</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {hook.data.events.map((e) => (
                <span className="badge plain" key={e}>
                  {e}
                </span>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>Recent deliveries</strong>
          </div>
          {events.loading ? (
            <Loading />
          ) : (events.data?.data.length ?? 0) === 0 ? (
            <Empty
              emoji="📡"
              title="No deliveries yet"
              description="Events appear here once they fire."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Sent</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {events.data?.data.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div>{row.type}</div>
                        <div className="dim mono" style={{ fontSize: 11 }}>
                          {row.id}
                        </div>
                      </td>
                      <td>
                        <Badge value={row.status} />
                      </td>
                      <td className="muted">{relativeTime(row.created_at)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setOpenEvent(openEvent === row.id ? null : row.id)}
                        >
                          Attempts
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {openEvent ? (
          <Card>
            <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <strong>Attempts</strong>{" "}
              <span className="dim mono" style={{ fontSize: 12 }}>
                {openEvent}
              </span>
            </div>
            {attempts.loading ? (
              <Loading />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Status code</th>
                      <th>Response</th>
                      <th>Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.data?.data.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Badge
                            value={String(a.http_status_code ?? "error")}
                            tone={a.http_status_code && a.http_status_code < 300 ? "ok" : "bad"}
                          />
                        </td>
                        <td className="truncate mono">{a.response ?? "—"}</td>
                        <td className="muted">{formatDate(a.sent_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const WebhooksPage = ({ route = "/webhooks" }: { route?: string }) => {
  const detailId = route.startsWith("/webhooks/") ? route.slice("/webhooks/".length) : null
  const { data, loading, reload } = useResource<List<WebhookRow>>(detailId ? null : "/webhooks")
  const [creating, setCreating] = useState(false)
  const [endpoint, setEndpoint] = useState("")
  const [selected, setSelected] = useState<string[]>([
    "email.sent",
    "email.delivered",
    "email.bounced",
  ])
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()

  if (detailId) return <WebhookDetailView id={detailId} />

  const create = async () => {
    setBusy(true)
    try {
      await post("/webhooks", { endpoint, events: selected })
      setCreating(false)
      setEndpoint("")
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Webhooks"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={14} /> Add webhook
          </button>
        }
      />

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="🪝"
            title="No webhooks yet"
            description="Receive real-time notifications about email events in your application."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Add webhook
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    onClick={() => navigate(`/webhooks/${row.id}`)}
                  >
                    <td className="truncate mono">{row.endpoint}</td>
                    <td className="muted">{row.events.length} events</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td className="muted">{formatDate(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <Modal
          title="Add webhook"
          subtitle="Outbox signs every request so you can verify it came from this server."
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
                disabled={busy || !endpoint.trim() || selected.length === 0}
              >
                {busy ? "Adding…" : "Add webhook"}
              </button>
            </>
          }
        >
          <Field label="Endpoint URL">
            <input
              className="input"
              placeholder="https://example.com/webhooks/outbox"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </Field>
          <Field label="Events">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              {EVENT_TYPES.map((type) => (
                <label className="row" key={type} style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(type)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? [...selected, type] : selected.filter((t) => t !== type),
                      )
                    }
                  />
                  {type}
                </label>
              ))}
            </div>
          </Field>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
