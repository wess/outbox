import type { Me } from "../app.tsx"
import { Badge, Card, Copyable, formatDate, Loading, PageHead } from "../components/index.tsx"
import type { List } from "../lib/api.ts"
import { useResource } from "../lib/hooks.ts"

type Member = {
  id: string
  email: string
  name: string | null
  role: string
  created_at: string
}

type Summary = Record<string, number>

export const SettingsPage = ({ me, onSignOut }: { me: Me; onSignOut: () => void }) => {
  const members = useResource<List<Member>>("/team/members")
  const summary = useResource<Summary>("/dashboard/summary")

  const base = window.location.origin

  return (
    <>
      <PageHead title="Settings" />

      <div className="stack">
        <Card pad>
          <h2>Team</h2>
          <div className="grid-2">
            <div>
              <div className="dim">Name</div>
              <div>{me.team.name}</div>
            </div>
            <div>
              <div className="dim">Slug</div>
              <code>{me.team.slug}</code>
            </div>
            <div>
              <div className="dim">Team ID</div>
              <code>{me.team.id}</code>
            </div>
            <div>
              <div className="dim">Signed in as</div>
              <div className="row">
                {me.email}
                {me.is_owner ? <Badge value="instance owner" tone="ok" /> : null}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border)" }}>
            <strong>Members</strong>
          </div>
          {members.loading ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data?.data.map((m) => (
                    <tr key={m.id}>
                      <td>{m.email}</td>
                      <td className="muted">{m.name ?? "—"}</td>
                      <td>
                        <span className="badge plain">{m.role}</span>
                      </td>
                      <td className="muted">{formatDate(m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card pad>
          <h2>API</h2>
          <div className="field">
            <div className="field-label">Base URL</div>
            <div className="row">
              <code style={{ flex: 1 }}>{base}</code>
              <Copyable value={base} />
            </div>
            <div className="hint">
              Point any Resend SDK at this URL and it will work unchanged — the request and response
              shapes are the same.
            </div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <div className="field-label">Example</div>
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
              {`curl -X POST '${base}/emails' \\
  -H 'Authorization: Bearer ob_yourapikey' \\
  -H 'User-Agent: my-app/1.0' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "from": "Acme <onboarding@yourdomain.com>",
    "to": ["someone@example.com"],
    "subject": "Hello World",
    "html": "<strong>It works!</strong>"
  }'`}
            </pre>
          </div>
        </Card>

        <Card pad>
          <h2>Usage</h2>
          <div className="stats" style={{ marginBottom: 0 }}>
            {[
              ["Emails", "emails"],
              ["Contacts", "contacts"],
              ["Templates", "templates"],
              ["Segments", "segments"],
              ["Suppressions", "suppressions"],
              ["Webhooks", "webhooks"],
              ["Automations", "automations"],
              ["API keys", "api_keys"],
            ].map(([label, key]) => (
              <div className="stat" key={key}>
                <div className="stat-label">{label}</div>
                <div className="stat-value">{summary.data?.[key!] ?? 0}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card pad>
          <h2>Session</h2>
          <button type="button" className="btn btn-danger" onClick={onSignOut}>
            Sign out
          </button>
        </Card>
      </div>
    </>
  )
}
