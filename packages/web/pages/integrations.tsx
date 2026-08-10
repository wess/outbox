import { useState } from "react"
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

type Integration = {
  id: string
  provider: string
  name: string | null
  base_url: string
  settings: Record<string, unknown>
  status: string
  last_error: string | null
  last_checked_at: string | null
  created_at: string
}

type ContentType = { name: string; label: string; kind: string }
type Entry = {
  id: string
  slug: string
  title: string
  excerpt: string
  published_at: string | null
}

const PROVIDERS = [
  {
    id: "inkling",
    label: "Inkling",
    emoji: "📝",
    blurb: "Headless CMS. Pull a published entry straight into a broadcast.",
    docs: "https://github.com/wess/inkling",
    // What to run on the other side to get a token.
    command: "bun run connect",
  },
] as const

const InklingBrowser = ({ integration }: { integration: Integration }) => {
  const types = useResource<List<ContentType>>("/integrations/inkling/types")
  const [type, setType] = useState<string>("")
  const active = type || types.data?.data[0]?.name || ""
  const entries = useResource<List<Entry>>(
    active ? `/integrations/inkling/content/${active}?limit=20` : null,
  )
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)
  const { toast, fail } = useToast()

  const showPreview = async (slug: string) => {
    try {
      const result = await fetch(`/integrations/inkling/content/${active}/${slug}/preview`, {
        credentials: "same-origin",
      }).then((r) => r.json())
      setPreview(result)
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <Card>
        <div className="card-pad row-between" style={{ borderBottom: "1px solid var(--border)" }}>
          <strong>Content</strong>
          <select
            className="select"
            style={{ width: "auto" }}
            value={active}
            onChange={(e) => setType(e.target.value)}
          >
            {types.data?.data.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {entries.loading ? (
          <Loading />
        ) : (entries.data?.data.length ?? 0) === 0 ? (
          <Empty
            emoji="📄"
            title="Nothing published"
            description="Publish an entry in Inkling and it will appear here, ready to broadcast."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Published</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.data?.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <div>{entry.title}</div>
                      <div className="dim truncate" style={{ fontSize: 12.5 }}>
                        {entry.excerpt}
                      </div>
                    </td>
                    <td className="muted">{formatDate(entry.published_at)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => showPreview(entry.slug)}
                      >
                        Preview email
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {preview ? (
        <Modal
          title={preview.subject}
          subtitle="Exactly what a broadcast built from this entry would send."
          onClose={() => setPreview(null)}
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setPreview(null)}>
              Close
            </button>
          }
        >
          <iframe
            title="Email preview"
            srcDoc={preview.html}
            sandbox=""
            style={{
              width: "100%",
              height: 420,
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "#fff",
            }}
          />
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}

export const IntegrationsPage = () => {
  const { data, loading, reload } = useResource<List<Integration>>("/integrations")
  const [connecting, setConnecting] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [siteUrl, setSiteUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const { toast, show, fail } = useToast()

  const connected = new Map((data?.data ?? []).map((i) => [i.provider, i]))

  const connect = async () => {
    if (!connecting) return
    setBusy(true)
    try {
      const result = await post<{ detail: string }>("/integrations/connect", {
        provider: connecting,
        token: token.trim(),
        ...(siteUrl.trim() ? { settings: { site_url: siteUrl.trim() } } : {}),
      })
      show(`Connected — ${result.detail}`)
      setConnecting(null)
      setToken("")
      setSiteUrl("")
      reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const check = async (provider: string) => {
    try {
      const result = await post<{ ok: boolean; detail: string }>(`/integrations/${provider}/check`)
      show(result.detail)
      reload()
    } catch (err) {
      fail(err)
    }
  }

  const disconnect = async (provider: string) => {
    try {
      await del(`/integrations/${provider}`)
      show("Disconnected")
      reload()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <PageHead title="Integrations" />

      {loading ? (
        <Loading />
      ) : (
        <div className="stack">
          {PROVIDERS.map((provider) => {
            const existing = connected.get(provider.id)
            return (
              <Card key={provider.id} pad>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
                    <div style={{ fontSize: 30, lineHeight: 1 }}>{provider.emoji}</div>
                    <div>
                      <div className="row" style={{ gap: 9 }}>
                        <strong style={{ fontSize: 15 }}>{provider.label}</strong>
                        {existing ? (
                          <Badge
                            value={existing.status}
                            tone={existing.status === "connected" ? "ok" : "bad"}
                          />
                        ) : null}
                      </div>
                      <div className="muted" style={{ marginTop: 3 }}>
                        {provider.blurb}
                      </div>
                      {existing ? (
                        <div className="dim" style={{ marginTop: 6, fontSize: 12.5 }}>
                          {existing.base_url}
                          {existing.last_checked_at
                            ? ` · checked ${formatDate(existing.last_checked_at)}`
                            : null}
                        </div>
                      ) : null}
                      {existing?.last_error ? (
                        <div className="error-text">{existing.last_error}</div>
                      ) : null}
                    </div>
                  </div>

                  <div className="row">
                    {existing ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => check(provider.id)}
                        >
                          <Icon path={icons.refresh} size={13} /> Check
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setConnecting(provider.id)}
                        >
                          Reconnect
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => disconnect(provider.id)}
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => setConnecting(provider.id)}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}

          {connected.has("inkling") ? (
            <InklingBrowser integration={connected.get("inkling")!} />
          ) : null}

          <Card pad>
            <h2>Connecting this Outbox to another service</h2>
            <p className="muted">
              Run this here, then paste the token into the other side. It carries the URL and an API
              key together, so there is one field to fill rather than two to get wrong.
            </p>
            <pre
              className="mono"
              style={{
                margin: 0,
                padding: 14,
                background: "var(--bg-raised)",
                borderRadius: 8,
                overflowX: "auto",
              }}
            >
              bun run bin/outbox.ts connect
            </pre>
            <div className="hint">
              Add <code>--send-only</code> for a key that can do nothing but send email.
            </div>
          </Card>
        </div>
      )}

      {connecting ? (
        <Modal
          title={`Connect ${PROVIDERS.find((p) => p.id === connecting)?.label}`}
          subtitle="One paste. The token carries the URL and the key."
          onClose={() => setConnecting(null)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConnecting(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={connect}
                disabled={busy || !token.trim()}
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
            </>
          }
        >
          <Field
            label="Connection token"
            hint={`Run \`${PROVIDERS.find((p) => p.id === connecting)?.command}\` in ${
              PROVIDERS.find((p) => p.id === connecting)?.label
            } and paste what it prints.`}
          >
            <textarea
              className="textarea"
              style={{ minHeight: 90 }}
              placeholder="inkc_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <Field
            label="Public site URL"
            hint="Optional. Used to link entries from the emails you build from this content."
          >
            <input
              className="input"
              placeholder="https://example.com"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
            />
          </Field>
        </Modal>
      ) : null}

      {toast ? <div className={`toast ${toast.kind}`}>{toast.message}</div> : null}
    </>
  )
}
