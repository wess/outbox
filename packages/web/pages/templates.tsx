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
import { del, type List, patch, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

type Variable = { id: string; key: string; type: string; fallback_value: unknown }

type Template = {
  id: string
  name: string
  alias: string | null
  status: string
  from: string | null
  subject: string | null
  html: string | null
  text: string | null
  variables: Variable[]
  has_unpublished_versions: boolean
  created_at: string
  updated_at: string
}

const TemplateDetailView = ({ id }: { id: string }) => {
  const { data, loading, reload } = useResource<Template>(`/templates/${id}`)
  const { toast, show, fail } = useToast()
  const [draft, setDraft] = useState<{ subject: string; html: string; from: string } | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <Loading />
  if (!data)
    return <Empty emoji="📄" title="Template not found" description="It may have been deleted." />

  const editing = draft ?? {
    subject: data.subject ?? "",
    html: data.html ?? "",
    from: data.from ?? "",
  }

  const save = async () => {
    setBusy(true)
    try {
      await patch(`/templates/${id}`, {
        subject: editing.subject,
        html: editing.html,
        from: editing.from || undefined,
      })
      show("Draft version saved")
      setDraft(null)
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    try {
      await post(`/templates/${id}/publish`)
      show("Published")
      reload()
    } catch (err) {
      fail(err)
    }
  }

  const duplicate = async () => {
    try {
      const copy = await post<{ id: string }>(`/templates/${id}/duplicate`)
      navigate(`/templates/${copy.id}`)
    } catch (err) {
      fail(err)
    }
  }

  const remove = async () => {
    try {
      await del(`/templates/${id}`)
      navigate("/templates")
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
            <button type="button" className="btn" onClick={() => navigate("/templates")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            <button type="button" className="btn" onClick={duplicate}>
              Duplicate
            </button>
            <button
              type="button"
              className="btn"
              onClick={publish}
              disabled={!data.has_unpublished_versions}
            >
              Publish
            </button>
            <button type="button" className="btn btn-danger" onClick={remove}>
              <Icon path={icons.trash} size={14} /> Delete
            </button>
          </>
        }
      />

      <div className="stack">
        <Card pad>
          <div className="row-between">
            <div className="row" style={{ gap: 18 }}>
              <div>
                <div className="dim">Status</div>
                <Badge value={data.status} />
              </div>
              <div>
                <div className="dim">Alias</div>
                <code>{data.alias ?? "—"}</code>
              </div>
              <div>
                <div className="dim">Updated</div>
                <div>{formatDate(data.updated_at)}</div>
              </div>
            </div>
            {data.has_unpublished_versions ? (
              <Badge value="unpublished changes" tone="warn" />
            ) : null}
          </div>
        </Card>

        <Card pad>
          <h2>Content</h2>
          <Field label="From">
            <input
              className="input"
              value={editing.from}
              placeholder="Acme <hello@yourdomain.com>"
              onChange={(e) => setDraft({ ...editing, from: e.target.value })}
            />
          </Field>
          <Field label="Subject" hint="Supports {{{VARIABLE}}} substitution.">
            <input
              className="input"
              value={editing.subject}
              onChange={(e) => setDraft({ ...editing, subject: e.target.value })}
            />
          </Field>
          <Field label="HTML">
            <textarea
              className="textarea"
              style={{ minHeight: 240 }}
              value={editing.html}
              onChange={(e) => setDraft({ ...editing, html: e.target.value })}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={busy || !draft}
            >
              {busy ? "Saving…" : "Save draft version"}
            </button>
            {draft ? (
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                Discard
              </button>
            ) : null}
          </div>
        </Card>

        {data.variables.length ? (
          <Card>
            <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <strong>Variables</strong>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Fallback</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variables.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <code>{`{{{${v.key}}}}`}</code>
                      </td>
                      <td>
                        <span className="badge plain">{v.type}</span>
                      </td>
                      <td className="muted">{String(v.fallback_value ?? "—")}</td>
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
              title="Template preview"
              srcDoc={data.html}
              sandbox=""
              style={{ width: "100%", height: 380, border: "none", background: "#fff" }}
            />
          </Card>
        ) : null}
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const TemplatesPage = ({ route = "/templates" }: { route?: string }) => {
  const detailId = route.startsWith("/templates/") ? route.slice("/templates/".length) : null
  const { data, loading, reload } = useResource<List<Template>>(detailId ? null : "/templates")
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: "", alias: "", subject: "", html: "" })
  const [busy, setBusy] = useState(false)
  const { toast, fail } = useToast()

  if (detailId) return <TemplateDetailView id={detailId} />

  const create = async () => {
    setBusy(true)
    try {
      const created = await post<{ id: string }>("/templates", {
        name: form.name,
        alias: form.alias || undefined,
        subject: form.subject || undefined,
        html: form.html || "<p>Hello</p>",
      })
      setCreating(false)
      setForm({ name: "", alias: "", subject: "", html: "" })
      reload()
      navigate(`/templates/${created.id}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Templates"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={14} /> Create template
          </button>
        }
      />

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="📄"
            title="No templates yet"
            description="Templates keep your email content out of your codebase and versioned here."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create template
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Alias</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    onClick={() => navigate(`/templates/${row.id}`)}
                  >
                    <td>{row.name}</td>
                    <td>{row.alias ? <code>{row.alias}</code> : <span className="dim">—</span>}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td className="muted">{formatDate(row.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <Modal
          title="Create template"
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
                disabled={busy || !form.name.trim()}
              >
                {busy ? "Creating…" : "Create"}
              </button>
            </>
          }
        >
          <Field label="Name">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Alias" hint="Optional stable id you can send to instead of the UUID.">
            <input
              className="input"
              placeholder="reset-password"
              value={form.alias}
              onChange={(e) => setForm({ ...form, alias: e.target.value })}
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
              placeholder="<h1>Hello {{{NAME}}}</h1>"
              onChange={(e) => setForm({ ...form, html: e.target.value })}
            />
          </Field>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
