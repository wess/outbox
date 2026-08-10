import { useState } from "react"
import {
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
} from "../components/index.tsx"
import { del, type List, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

type KeyRow = { id: string; name: string; created_at: string }
type DomainRow = { id: string; name: string }

export const ApiKeysPage = () => {
  const { data, loading, reload } = useResource<List<KeyRow>>("/api-keys")
  const domains = useResource<List<DomainRow>>("/domains")
  const { toast, show, fail } = useToast()
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<string | null>(null)
  const [form, setForm] = useState({ name: "", permission: "full_access", domain_id: "" })
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const result = await post<{ id: string; token: string }>("/api-keys", {
        name: form.name,
        permission: form.permission,
        ...(form.domain_id ? { domain_id: form.domain_id } : {}),
      })
      setCreating(false)
      setForm({ name: "", permission: "full_access", domain_id: "" })
      setIssued(result.token)
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await del(`/api-keys/${id}`)
      show("API key deleted")
      reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHead
        title="API keys"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={14} /> Create API key
          </button>
        }
      />

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="🔑"
            title="No API keys yet"
            description="Generate an API key to authenticate requests and send emails through the API."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Create API key
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td className="muted">{formatDate(row.created_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => remove(row.id)}
                      >
                        <Icon path={icons.trash} size={13} /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <Modal
          title="Create API key"
          subtitle="The token is shown once. Store it somewhere safe."
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
              placeholder="Production"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="Permission"
            hint="Sending access can only call the send endpoints — useful for keys that ship to clients."
          >
            <select
              className="select"
              value={form.permission}
              onChange={(e) => setForm({ ...form, permission: e.target.value })}
            >
              <option value="full_access">Full access</option>
              <option value="sending_access">Sending access</option>
            </select>
          </Field>
          <Field
            label="Restrict to domain"
            hint="Optional. The key may then only send from this domain."
          >
            <select
              className="select"
              value={form.domain_id}
              onChange={(e) => setForm({ ...form, domain_id: e.target.value })}
            >
              <option value="">All domains</option>
              {domains.data?.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </Modal>
      ) : null}

      {issued ? (
        <Modal
          title="API key created"
          subtitle="Copy it now — this is the only time it is shown."
          onClose={() => setIssued(null)}
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setIssued(null)}>
              Done
            </button>
          }
        >
          <div className="card card-pad row-between" style={{ gap: 12 }}>
            <code style={{ wordBreak: "break-all" }}>{issued}</code>
            <Copyable value={issued} />
          </div>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
