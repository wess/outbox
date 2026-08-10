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
} from "../components/index.tsx"
import { del, type List, patch, post } from "../lib/api.ts"
import { useResource, useToast } from "../lib/hooks.ts"

type DomainRow = {
  id: string
  name: string
  status: string
  created_at: string
  region: string
}

type DnsRecord = {
  record: string
  name: string
  type: string
  ttl: string
  status: string
  value: string
  priority?: number
}

type DomainDetail = DomainRow & {
  open_tracking: boolean
  click_tracking: boolean
  tracking_subdomain: string
  tls: string
  custom_return_path: string
  capabilities: { sending: string; receiving: string }
  records: DnsRecord[]
}

const AddDomainModal = ({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) => {
  const [name, setName] = useState("")
  const [openTracking, setOpenTracking] = useState(false)
  const [clickTracking, setClickTracking] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const created = await post<{ id: string }>("/domains", {
        name: name.trim(),
        open_tracking: openTracking,
        click_tracking: clickTracking,
        capabilities: { sending: "enabled", receiving: receiving ? "enabled" : "disabled" },
      })
      onAdded()
      onClose()
      navigate(`/domains/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add domain"
      subtitle="Outbox generates a DKIM key pair and the DNS records you need to publish."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || !name.trim()}
          >
            {busy ? "Adding…" : "Add domain"}
          </button>
        </>
      }
    >
      <Field
        label="Domain"
        hint="A subdomain such as mail.example.com keeps your root domain reputation separate."
      >
        <input
          className="input"
          placeholder="example.com"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <label className="row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={openTracking}
          onChange={(e) => setOpenTracking(e.target.checked)}
        />
        Track opens
      </label>
      <label className="row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={clickTracking}
          onChange={(e) => setClickTracking(e.target.checked)}
        />
        Track clicks
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={receiving}
          onChange={(e) => setReceiving(e.target.checked)}
        />
        Receive inbound email
      </label>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  )
}

const DomainDetailView = ({ id }: { id: string }) => {
  const { data, loading, reload } = useResource<DomainDetail>(`/domains/${id}`)
  const { toast, show, fail } = useToast()
  const [verifying, setVerifying] = useState(false)

  if (loading) return <Loading />
  if (!data)
    return <Empty emoji="🌐" title="Domain not found" description="It may have been deleted." />

  const verify = async () => {
    setVerifying(true)
    try {
      await post(`/domains/${id}/verify`)
      show("Verification check complete")
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setVerifying(false)
    }
  }

  const toggle = async (field: string, value: boolean) => {
    try {
      await patch(`/domains/${id}`, { [field]: value })
      reload()
    } catch (err) {
      fail(err)
    }
  }

  const remove = async () => {
    try {
      await del(`/domains/${id}`)
      navigate("/domains")
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
            <button type="button" className="btn" onClick={() => navigate("/domains")}>
              <Icon path={icons.back} size={14} /> Back
            </button>
            <button type="button" className="btn" onClick={verify} disabled={verifying}>
              <Icon path={icons.refresh} size={14} /> {verifying ? "Checking…" : "Verify DNS"}
            </button>
            <button type="button" className="btn btn-danger" onClick={remove}>
              <Icon path={icons.trash} size={14} /> Delete
            </button>
          </>
        }
      />

      <div className="stack">
        <Card pad>
          <div className="grid-2">
            <div>
              <div className="dim">Status</div>
              <Badge value={data.status} />
            </div>
            <div>
              <div className="dim">Region</div>
              <div>{data.region}</div>
            </div>
            <div>
              <div className="dim">Sending</div>
              <Badge value={data.capabilities.sending} />
            </div>
            <div>
              <div className="dim">Receiving</div>
              <Badge value={data.capabilities.receiving} />
            </div>
            <div>
              <div className="dim">TLS</div>
              <div>{data.tls}</div>
            </div>
            <div>
              <div className="dim">Added</div>
              <div>{formatDate(data.created_at)}</div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 16, gap: 20, flexWrap: "wrap" }}>
            <label className="row">
              <input
                type="checkbox"
                checked={data.open_tracking}
                onChange={(e) => toggle("open_tracking", e.target.checked)}
              />
              Open tracking
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={data.click_tracking}
                onChange={(e) => toggle("click_tracking", e.target.checked)}
              />
              Click tracking
            </label>
          </div>
        </Card>

        <Card>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>DNS records</strong>
            <div className="hint">
              Publish these with your DNS provider, then run Verify. A domain counts as verified
              once SPF and DKIM resolve.
            </div>
          </div>
          <div className="table-wrap dns-table">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Value</th>
                  <th>TTL</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.records.map((r) => (
                  <tr key={`${r.record}-${r.type}-${r.name}`}>
                    <td>
                      <span className="badge plain">{r.type}</span>
                      <div className="dim" style={{ fontSize: 11, marginTop: 3 }}>
                        {r.record}
                      </div>
                    </td>
                    <td className="mono">{r.name}</td>
                    <td className="mono" style={{ maxWidth: 380 }}>
                      {r.value}
                      {r.priority !== undefined ? (
                        <div className="dim">priority {r.priority}</div>
                      ) : null}
                    </td>
                    <td className="muted">{r.ttl}</td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                    <td>
                      <Copyable value={r.value} label="" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const DomainsPage = ({ route = "/domains" }: { route?: string }) => {
  const detailId = route.startsWith("/domains/") ? route.slice("/domains/".length) : null
  const [showAdd, setShowAdd] = useState(false)
  const [status, setStatus] = useState("")
  const { data, loading, reload } = useResource<List<DomainRow>>(detailId ? null : "/domains")

  if (detailId) return <DomainDetailView id={detailId} />

  const rows = (data?.data ?? []).filter((d) => !status || d.status === status)

  return (
    <>
      <PageHead
        title="Domains"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Icon path={icons.plus} size={14} /> Add domain
          </button>
        }
      />

      <div className="filters">
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="not_started">Not started</option>
          <option value="pending">Pending</option>
          <option value="verified">Verified</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      <Card>
        {loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            emoji="🌐"
            title="No domains yet"
            description="Verify a domain by publishing its DNS records to start sending from your own address."
            action={
              <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
                Add domain
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Region</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable"
                    onClick={() => navigate(`/domains/${row.id}`)}
                  >
                    <td>{row.name}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                    <td className="muted">{row.region}</td>
                    <td className="muted">{formatDate(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showAdd ? <AddDomainModal onClose={() => setShowAdd(false)} onAdded={reload} /> : null}
    </>
  )
}
