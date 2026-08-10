import { useMemo, useState } from "react"
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
  Pager,
  relativeTime,
} from "../components/index.tsx"
import { type List, post, qs } from "../lib/api.ts"
import { useDebounced, useResource, useToast } from "../lib/hooks.ts"

type EmailRow = {
  id: string
  message_id: string | null
  to: string[]
  from: string
  subject: string
  created_at: string
  last_event: string
  scheduled_at: string | null
}

type EmailDetail = EmailRow & {
  html: string | null
  text: string | null
  cc: string[]
  bcc: string[]
  reply_to: string[]
  tags: { name: string; value: string }[]
}

type Received = {
  id: string
  from: string
  to: string[]
  subject: string | null
  created_at: string
}

const STATUSES = [
  "queued",
  "scheduled",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
  "canceled",
  "suppressed",
]

const SendModal = ({ onClose, onSent }: { onClose: () => void; onSent: () => void }) => {
  const [form, setForm] = useState({ from: "", to: "", subject: "", html: "", scheduled_at: "" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await post("/emails", {
        from: form.from,
        to: form.to
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        subject: form.subject,
        html: form.html,
        ...(form.scheduled_at ? { scheduled_at: form.scheduled_at } : {}),
      })
      onSent()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Send email"
      subtitle="Sends through the same API your application uses."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? "Sending…" : "Send"}
          </button>
        </>
      }
    >
      <Field label="From" hint="Must use a domain you have added.">
        <input
          className="input"
          placeholder="Acme <onboarding@yourdomain.com>"
          value={form.from}
          onChange={(e) => setForm({ ...form, from: e.target.value })}
        />
      </Field>
      <Field label="To" hint="Comma-separated for multiple recipients.">
        <input
          className="input"
          placeholder="someone@example.com"
          value={form.to}
          onChange={(e) => setForm({ ...form, to: e.target.value })}
        />
      </Field>
      <Field label="Subject">
        <input
          className="input"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
      </Field>
      <Field label="HTML">
        <textarea
          className="textarea"
          value={form.html}
          placeholder="<h1>Hello</h1>"
          onChange={(e) => setForm({ ...form, html: e.target.value })}
        />
      </Field>
      <Field
        label="Schedule"
        hint="Leave empty to send now. Accepts `in 1 hour` or an ISO 8601 date."
      >
        <input
          className="input"
          placeholder="in 1 hour"
          value={form.scheduled_at}
          onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })}
        />
      </Field>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  )
}

const EmailDetailView = ({ id }: { id: string }) => {
  const { data, loading, reload } = useResource<EmailDetail>(`/emails/${id}`)
  const { toast, show, fail } = useToast()

  if (loading) return <Loading />
  if (!data)
    return <Empty emoji="📭" title="Email not found" description="It may have been deleted." />

  const cancel = async () => {
    try {
      await post(`/emails/${id}/cancel`)
      show("Email canceled")
      reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHead
        title={data.subject || "(no subject)"}
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate("/emails")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            {data.last_event === "scheduled" ? (
              <button type="button" className="btn btn-danger" onClick={cancel}>
                Cancel send
              </button>
            ) : null}
          </>
        }
      />

      <div className="stack">
        <Card pad>
          <div className="grid-2">
            <div>
              <div className="dim">From</div>
              <div>{data.from}</div>
            </div>
            <div>
              <div className="dim">To</div>
              <div>{data.to.join(", ")}</div>
            </div>
            {data.cc?.length ? (
              <div>
                <div className="dim">Cc</div>
                <div>{data.cc.join(", ")}</div>
              </div>
            ) : null}
            {data.reply_to?.length ? (
              <div>
                <div className="dim">Reply-To</div>
                <div>{data.reply_to.join(", ")}</div>
              </div>
            ) : null}
            <div>
              <div className="dim">Status</div>
              <Badge value={data.last_event} />
            </div>
            <div>
              <div className="dim">Created</div>
              <div>{formatDate(data.created_at)}</div>
            </div>
            {data.scheduled_at ? (
              <div>
                <div className="dim">Scheduled</div>
                <div>{formatDate(data.scheduled_at)}</div>
              </div>
            ) : null}
            <div>
              <div className="dim">Message ID</div>
              <div className="mono truncate">{data.message_id ?? "—"}</div>
            </div>
          </div>

          {data.tags?.length ? (
            <div style={{ marginTop: 14 }}>
              <div className="dim" style={{ marginBottom: 6 }}>
                Tags
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {data.tags.map((t) => (
                  <span className="badge plain" key={`${t.name}:${t.value}`}>
                    {t.name}={t.value}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <Card>
          <div className="card-pad row-between" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>Preview</strong>
            <Copyable value={data.html ?? data.text ?? ""} label="Copy body" />
          </div>
          {data.html ? (
            <iframe
              title="Email preview"
              srcDoc={data.html}
              sandbox=""
              style={{ width: "100%", height: 440, border: "none", background: "#fff" }}
            />
          ) : (
            <pre className="card-pad mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {data.text ?? "(empty body)"}
            </pre>
          )}
        </Card>
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const EmailsPage = ({ route = "/emails" }: { route?: string }) => {
  const detailId = route.startsWith("/emails/") ? route.slice("/emails/".length) : null
  const [tab, setTab] = useState<"sending" | "receiving">("sending")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("")
  const [cursors, setCursors] = useState<string[]>([])
  const [showSend, setShowSend] = useState(false)
  const debounced = useDebounced(search)

  const after = cursors[cursors.length - 1]
  const path =
    tab === "sending"
      ? `/emails${qs({ limit: 25, after })}`
      : `/emails/receiving${qs({ limit: 25, after })}`

  const sending = useResource<List<EmailRow>>(detailId ? null : tab === "sending" ? path : null)
  const receiving = useResource<List<Received>>(detailId ? null : tab === "receiving" ? path : null)

  const rows = useMemo(() => {
    const data = sending.data?.data ?? []
    const term = debounced.trim().toLowerCase()
    return data.filter((r) => {
      if (status && r.last_event !== status) return false
      if (!term) return true
      return (
        r.subject?.toLowerCase().includes(term) ||
        r.from?.toLowerCase().includes(term) ||
        r.to?.some((t) => t.toLowerCase().includes(term))
      )
    })
  }, [sending.data, debounced, status])

  if (detailId) return <EmailDetailView id={detailId} />

  const nextPage = () => {
    const list = tab === "sending" ? sending.data?.data : receiving.data?.data
    const last = list?.[list.length - 1]
    if (last) setCursors([...cursors, last.id])
  }

  return (
    <>
      <PageHead
        title="Emails"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowSend(true)}>
            <Icon path={icons.plus} size={14} /> Send email
          </button>
        }
      />

      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === "sending" ? " active" : ""}`}
          onClick={() => {
            setTab("sending")
            setCursors([])
          }}
        >
          Sending
        </button>
        <button
          type="button"
          className={`tab${tab === "receiving" ? " active" : ""}`}
          onClick={() => {
            setTab("receiving")
            setCursors([])
          }}
        >
          Receiving
        </button>
      </div>

      {tab === "sending" ? (
        <>
          <div className="filters">
            <input
              className="input"
              placeholder="Search subject, sender, or recipient…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <Card>
            {sending.loading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <Empty
                emoji="📤"
                title="No sent emails yet"
                description="Start sending emails to see insights and previews for every message."
                action={
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setShowSend(true)}
                  >
                    Send your first email
                  </button>
                }
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>To</th>
                      <th>Subject</th>
                      <th>Status</th>
                      <th>Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className="clickable"
                        onClick={() => navigate(`/emails/${row.id}`)}
                      >
                        <td className="truncate">{row.to?.join(", ")}</td>
                        <td className="truncate">
                          {row.subject || <span className="dim">(none)</span>}
                        </td>
                        <td>
                          <Badge value={row.last_event} />
                        </td>
                        <td className="muted">{relativeTime(row.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Pager
            hasMore={Boolean(sending.data?.has_more)}
            onNext={nextPage}
            onPrev={() => setCursors(cursors.slice(0, -1))}
            canPrev={cursors.length > 0}
          />
        </>
      ) : (
        <>
          <Card>
            {receiving.loading ? (
              <Loading />
            ) : (receiving.data?.data.length ?? 0) === 0 ? (
              <Empty
                emoji="📥"
                title="No received emails"
                description="Enable receiving on a domain and point its MX record at this server."
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>Subject</th>
                      <th>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiving.data?.data.map((row) => (
                      <tr key={row.id}>
                        <td className="truncate">{row.from}</td>
                        <td className="truncate">
                          {row.subject || <span className="dim">(none)</span>}
                        </td>
                        <td className="muted">{relativeTime(row.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Pager
            hasMore={Boolean(receiving.data?.has_more)}
            onNext={nextPage}
            onPrev={() => setCursors(cursors.slice(0, -1))}
            canPrev={cursors.length > 0}
          />
        </>
      )}

      {showSend ? (
        <SendModal
          onClose={() => setShowSend(false)}
          onSent={() => (tab === "sending" ? sending.reload() : receiving.reload())}
        />
      ) : null}
    </>
  )
}
