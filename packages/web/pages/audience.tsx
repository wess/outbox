import { useMemo, useState } from "react"
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
import { del, type List, patch, post, qs } from "../lib/api.ts"
import { useDebounced, useResource, useToast } from "../lib/hooks.ts"

type Contact = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  unsubscribed: boolean
  created_at: string
  properties: Record<string, unknown>
}
type Segment = { id: string; name: string; created_at: string }
type Topic = {
  id: string
  name: string
  description: string | null
  default_subscription: string
  visibility: string
  created_at: string
}
type Property = {
  id: string
  key: string
  type: string
  fallback_value: unknown
  created_at: string
}
type Suppression = { id: string; email: string; origin: string; created_at: string }

type Tab = "contacts" | "segments" | "topics" | "properties" | "suppressions"

const TABS: { key: Tab; label: string }[] = [
  { key: "contacts", label: "Contacts" },
  { key: "segments", label: "Segments" },
  { key: "topics", label: "Topics" },
  { key: "properties", label: "Properties" },
  { key: "suppressions", label: "Suppression list" },
]

const ContactsTab = () => {
  const [search, setSearch] = useState("")
  const [segmentId, setSegmentId] = useState("")
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ email: "", first_name: "", last_name: "" })
  const [busy, setBusy] = useState(false)
  const debounced = useDebounced(search)
  const { toast, show, fail } = useToast()

  const segments = useResource<List<Segment>>("/segments")
  const contacts = useResource<List<Contact>>(`/contacts${qs({ segment_id: segmentId })}`)

  const rows = useMemo(() => {
    const term = debounced.trim().toLowerCase()
    return (contacts.data?.data ?? []).filter(
      (c) =>
        !term ||
        c.email.toLowerCase().includes(term) ||
        `${c.first_name ?? ""} ${c.last_name ?? ""}`.toLowerCase().includes(term),
    )
  }, [contacts.data, debounced])

  const create = async () => {
    setBusy(true)
    try {
      await post("/contacts", {
        email: form.email,
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
        ...(segmentId ? { segments: [{ id: segmentId }] } : {}),
      })
      setCreating(false)
      setForm({ email: "", first_name: "", last_name: "" })
      contacts.reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const toggleUnsubscribe = async (contact: Contact) => {
    try {
      await patch(`/contacts/${contact.id}`, { unsubscribed: !contact.unsubscribed })
      contacts.reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async (id: string) => {
    try {
      await del(`/contacts/${id}`)
      show("Contact deleted")
      contacts.reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <div className="filters">
        <input
          className="input"
          placeholder="Search contacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
          <option value="">All segments</option>
          {segments.data?.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon path={icons.plus} size={14} /> Add contact
        </button>
      </div>

      <Card>
        {contacts.loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            emoji="👥"
            title="No contacts yet"
            description="Contacts are the people you send broadcasts and automations to."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                Add contact
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.email}</td>
                    <td className="muted">
                      {[row.first_name, row.last_name].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td>
                      <Badge
                        value={row.unsubscribed ? "unsubscribed" : "subscribed"}
                        tone={row.unsubscribed ? "bad" : "ok"}
                      />
                    </td>
                    <td className="muted">{formatDate(row.created_at)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => toggleUnsubscribe(row)}
                        style={{ marginRight: 6 }}
                      >
                        {row.unsubscribed ? "Resubscribe" : "Unsubscribe"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => remove(row.id)}
                      >
                        <Icon path={icons.trash} size={13} />
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
          title="Add contact"
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
                disabled={busy || !form.email.trim()}
              >
                {busy ? "Adding…" : "Add"}
              </button>
            </>
          }
        >
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <div className="grid-2">
            <Field label="First name">
              <input
                className="input"
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              />
            </Field>
            <Field label="Last name">
              <input
                className="input"
                value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

const SimpleTab = <T extends { id: string; created_at: string }>({
  path,
  emoji,
  title,
  description,
  columns,
  createLabel,
  createFields,
  buildBody,
}: {
  path: string
  emoji: string
  title: string
  description: string
  columns: { header: string; render: (row: T) => React.ReactNode }[]
  createLabel: string
  createFields: (
    form: Record<string, string>,
    set: (next: Record<string, string>) => void,
  ) => React.ReactNode
  buildBody: (form: Record<string, string>) => unknown
}) => {
  const { data, loading, reload } = useResource<List<T>>(path)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { toast, show, fail } = useToast()

  const create = async () => {
    setBusy(true)
    try {
      await post(path, buildBody(form))
      setCreating(false)
      setForm({})
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await del(`${path}/${id}`)
      show("Deleted")
      reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <div className="filters">
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon path={icons.plus} size={14} /> {createLabel}
        </button>
      </div>

      <Card>
        {loading ? (
          <Loading />
        ) : (data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji={emoji}
            title={title}
            description={description}
            action={
              <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                {createLabel}
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.header}>{c.header}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr key={row.id}>
                    {columns.map((c) => (
                      <td key={c.header}>{c.render(row)}</td>
                    ))}
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => remove(row.id)}
                      >
                        <Icon path={icons.trash} size={13} />
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
          title={createLabel}
          onClose={() => setCreating(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          {createFields(form, setForm)}
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const AudiencePage = ({ route = "/audience" }: { route?: string }) => {
  const initial = (route.split("/")[2] as Tab) || "contacts"
  const [tab, setTab] = useState<Tab>(TABS.some((t) => t.key === initial) ? initial : "contacts")

  return (
    <>
      <PageHead title="Audience" />

      <div className="tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "contacts" ? <ContactsTab /> : null}

      {tab === "segments" ? (
        <SimpleTab<Segment>
          path="/segments"
          emoji="🗂️"
          title="No segments yet"
          description="Segments group contacts so a broadcast can target exactly the right people."
          createLabel="Create segment"
          columns={[
            { header: "Name", render: (r) => r.name },
            {
              header: "Created",
              render: (r) => <span className="muted">{formatDate(r.created_at)}</span>,
            },
          ]}
          createFields={(form, set) => (
            <Field label="Name">
              <input
                className="input"
                value={form.name ?? ""}
                onChange={(e) => set({ ...form, name: e.target.value })}
              />
            </Field>
          )}
          buildBody={(form) => ({ name: form.name })}
        />
      ) : null}

      {tab === "topics" ? (
        <SimpleTab<Topic>
          path="/topics"
          emoji="🔔"
          title="No topics yet"
          description="Topics let recipients choose which kinds of email they want, instead of all or nothing."
          createLabel="Create topic"
          columns={[
            { header: "Name", render: (r) => r.name },
            { header: "Default", render: (r) => <Badge value={r.default_subscription} /> },
            { header: "Visibility", render: (r) => <span className="muted">{r.visibility}</span> },
            {
              header: "Created",
              render: (r) => <span className="muted">{formatDate(r.created_at)}</span>,
            },
          ]}
          createFields={(form, set) => (
            <>
              <Field label="Name">
                <input
                  className="input"
                  value={form.name ?? ""}
                  onChange={(e) => set({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <input
                  className="input"
                  value={form.description ?? ""}
                  onChange={(e) => set({ ...form, description: e.target.value })}
                />
              </Field>
              <Field
                label="Default subscription"
                hint="Applied to anyone who is not already a contact with a preference."
              >
                <select
                  className="select"
                  value={form.default_subscription ?? "opt_in"}
                  onChange={(e) => set({ ...form, default_subscription: e.target.value })}
                >
                  <option value="opt_in">Opt in</option>
                  <option value="opt_out">Opt out</option>
                </select>
              </Field>
            </>
          )}
          buildBody={(form) => ({
            name: form.name,
            description: form.description || undefined,
            default_subscription: form.default_subscription ?? "opt_in",
          })}
        />
      ) : null}

      {tab === "properties" ? (
        <SimpleTab<Property>
          path="/contact-properties"
          emoji="🏷️"
          title="No contact properties yet"
          description="Properties store custom fields on a contact and can be used as template variables."
          createLabel="Create property"
          columns={[
            { header: "Key", render: (r) => <code>{r.key}</code> },
            { header: "Type", render: (r) => <span className="badge plain">{r.type}</span> },
            {
              header: "Fallback",
              render: (r) => <span className="muted">{String(r.fallback_value ?? "—")}</span>,
            },
          ]}
          createFields={(form, set) => (
            <>
              <Field label="Key" hint="Letters, numbers, and underscores.">
                <input
                  className="input"
                  placeholder="company_name"
                  value={form.key ?? ""}
                  onChange={(e) => set({ ...form, key: e.target.value })}
                />
              </Field>
              <Field label="Type">
                <select
                  className="select"
                  value={form.type ?? "string"}
                  onChange={(e) => set({ ...form, type: e.target.value })}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                </select>
              </Field>
              <Field
                label="Fallback value"
                hint="Used when a contact has no value for this property."
              >
                <input
                  className="input"
                  value={form.fallback_value ?? ""}
                  onChange={(e) => set({ ...form, fallback_value: e.target.value })}
                />
              </Field>
            </>
          )}
          buildBody={(form) => ({
            key: form.key,
            type: form.type ?? "string",
            fallback_value: form.fallback_value || undefined,
          })}
        />
      ) : null}

      {tab === "suppressions" ? (
        <SimpleTab<Suppression>
          path="/suppressions"
          emoji="🚫"
          title="Suppression list is empty"
          description="Bounced and complained addresses land here automatically and are never sent to again."
          createLabel="Add suppression"
          columns={[
            { header: "Email", render: (r) => r.email },
            { header: "Origin", render: (r) => <Badge value={r.origin} tone="plain" /> },
            {
              header: "Added",
              render: (r) => <span className="muted">{formatDate(r.created_at)}</span>,
            },
          ]}
          createFields={(form, set) => (
            <Field label="Email">
              <input
                className="input"
                type="email"
                value={form.email ?? ""}
                onChange={(e) => set({ ...form, email: e.target.value })}
              />
            </Field>
          )}
          buildBody={(form) => ({ email: form.email })}
        />
      ) : null}
    </>
  )
}
