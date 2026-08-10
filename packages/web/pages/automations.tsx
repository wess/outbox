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
  relativeTime,
} from "../components/index.tsx"
import { del, type List, patch, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

type Step = { key: string; type: string; config: Record<string, unknown> }
type Edge = { from: string; to: string; type: string }

type Automation = {
  id: string
  name: string
  description: string | null
  status: string
  created_at: string
  updated_at: string
  steps: Step[]
  edges: Edge[]
}

type Run = {
  id: string
  email: string | null
  status: string
  current_step_key: string | null
  started_at: string
  completed_at: string | null
  error: string | null
}

type RunDetail = Run & {
  steps: { key: string; type: string; status: string; error: string | null; created_at: string }[]
}

const STEP_LABEL: Record<string, string> = {
  trigger: "Trigger",
  condition: "Condition",
  delay: "Delay",
  wait_for_event: "Wait for event",
  send_email: "Send email",
  add_to_segment: "Add to segment",
  contact_update: "Update contact",
  contact_delete: "Delete contact",
}

const describe = (step: Step): string => {
  const c = step.config ?? {}
  switch (step.type) {
    case "trigger":
      return `on ${String(c.event_name ?? "?")}`
    case "condition":
      return `${String(c.field ?? "?")} ${String(c.operator ?? "")} ${String(c.value ?? "")}`
    case "delay":
      return c.seconds ? `${c.seconds}s` : `${String(c.duration ?? "")} ${String(c.unit ?? "")}`
    case "wait_for_event":
      return `until ${String(c.event_name ?? "?")}`
    case "send_email":
      return c.template_id
        ? `template ${String(c.template_id).slice(0, 8)}`
        : String(c.subject ?? "")
    default:
      return ""
  }
}

const AutomationDetailView = ({ id }: { id: string }) => {
  const automation = useResource<Automation>(`/automations/${id}`)
  const runs = useResource<List<Run>>(`/automations/${id}/runs?limit=25`)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const runDetail = useResource<RunDetail>(openRun ? `/automations/${id}/runs/${openRun}` : null)
  const { toast, show, fail } = useToast()

  if (automation.loading) return <Loading />
  if (!automation.data) {
    return <Empty emoji="⚙️" title="Automation not found" description="It may have been deleted." />
  }

  const data = automation.data

  const toggle = async () => {
    try {
      await patch(`/automations/${id}`, {
        status: data.status === "enabled" ? "disabled" : "enabled",
      })
      show(data.status === "enabled" ? "Automation disabled" : "Automation enabled")
      automation.reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async () => {
    try {
      await del(`/automations/${id}`)
      navigate("/automations")
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHead
        title={data.name}
        actions={
          <>
            <button type="button" className="btn" onClick={() => navigate("/automations")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            <button type="button" className="btn" onClick={toggle}>
              {data.status === "enabled" ? "Disable" : "Enable"}
            </button>
            <button type="button" className="btn btn-danger" onClick={remove}>
              <Icon path={icons.trash} size={14} /> Delete
            </button>
          </>
        }
      />

      <div className="stack">
        <Card pad>
          <div className="row" style={{ gap: 20 }}>
            <div>
              <div className="dim">Status</div>
              <Badge value={data.status} />
            </div>
            <div>
              <div className="dim">Steps</div>
              <div>{data.steps.length}</div>
            </div>
            <div>
              <div className="dim">Updated</div>
              <div>{formatDate(data.updated_at)}</div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>Workflow</strong>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Type</th>
                  <th>Configuration</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {data.steps.map((step) => {
                  const outgoing = data.edges.filter((e) => e.from === step.key)
                  return (
                    <tr key={step.key}>
                      <td>
                        <code>{step.key}</code>
                      </td>
                      <td>
                        <span className="badge plain">{STEP_LABEL[step.type] ?? step.type}</span>
                      </td>
                      <td className="muted truncate">{describe(step)}</td>
                      <td className="muted">
                        {outgoing.length === 0 ? (
                          <span className="dim">end</span>
                        ) : (
                          outgoing.map((e) => (
                            <div key={`${e.to}-${e.type}`}>
                              {e.type !== "default" ? (
                                <span className="dim">{e.type.replace(/_/g, " ")} → </span>
                              ) : null}
                              <code>{e.to}</code>
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>Runs</strong>
          </div>
          {runs.loading ? (
            <Loading />
          ) : (runs.data?.data.length ?? 0) === 0 ? (
            <Empty
              emoji="🏃"
              title="No runs yet"
              description="Send the trigger event to POST /events/send to start a run."
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {runs.data?.data.map((run) => (
                    <tr key={run.id}>
                      <td>{run.email ?? <span className="dim">—</span>}</td>
                      <td>
                        <Badge value={run.status} />
                      </td>
                      <td className="muted">{relativeTime(run.started_at)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setOpenRun(openRun === run.id ? null : run.id)}
                        >
                          Steps
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {openRun && runDetail.data ? (
          <Card>
            <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <strong>Run steps</strong>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {runDetail.data.steps.map((s, i) => (
                    <tr key={`${s.key}-${i}`}>
                      <td>
                        <code>{s.key}</code>
                      </td>
                      <td className="muted">{STEP_LABEL[s.type] ?? s.type}</td>
                      <td>
                        <Badge value={s.status} />
                        {s.error ? <div className="error-text">{s.error}</div> : null}
                      </td>
                      <td className="muted">{relativeTime(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

const STARTER = {
  steps: [
    { key: "start", type: "trigger", config: { event_name: "user.created" } },
    {
      key: "welcome",
      type: "send_email",
      config: { subject: "Welcome!", html: "<p>Glad you're here.</p>" },
    },
  ],
  edges: [{ from: "start", to: "welcome", type: "default" }],
}

export const AutomationsPage = ({ route = "/automations" }: { route?: string }) => {
  const detailId = route.startsWith("/automations/") ? route.slice("/automations/".length) : null
  const { data, loading, reload } = useResource<List<Automation>>(detailId ? null : "/automations")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [graph, setGraph] = useState(JSON.stringify(STARTER, null, 2))
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()

  if (detailId) return <AutomationDetailView id={detailId} />

  const create = async () => {
    setBusy(true)
    try {
      const parsed = JSON.parse(graph) as { steps: Step[]; edges: Edge[] }
      const created = await post<{ id: string }>("/automations", {
        name,
        status: "disabled",
        steps: parsed.steps,
        edges: parsed.edges,
      })
      setCreating(false)
      setName("")
      reload()
      navigate(`/automations/${created.id}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Automations"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={14} /> Create automation
          </button>
        }
      />

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="⚙️"
            title="No automations yet"
            description="Run a sequence of emails and actions whenever your application sends an event."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create automation
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Trigger</th>
                  <th>Steps</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => {
                  const trigger = row.steps.find((s) => s.type === "trigger")
                  return (
                    <tr
                      key={row.id}
                      className="clickable"
                      onClick={() => navigate(`/automations/${row.id}`)}
                    >
                      <td>{row.name}</td>
                      <td className="muted">
                        <code>{String(trigger?.config?.event_name ?? "—")}</code>
                      </td>
                      <td className="muted">{row.steps.length}</td>
                      <td>
                        <Badge value={row.status} />
                      </td>
                      <td className="muted">{formatDate(row.updated_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <Modal
          title="Create automation"
          subtitle="Define the workflow as steps plus the edges that connect them."
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
                disabled={busy || !name.trim()}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </>
          }
        >
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Workflow"
            hint="Exactly one trigger step is required. Condition steps branch on condition_met and condition_not_met edges."
          >
            <textarea
              className="textarea"
              style={{ minHeight: 260 }}
              value={graph}
              onChange={(e) => setGraph(e.target.value)}
            />
          </Field>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
