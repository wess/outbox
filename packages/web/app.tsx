import { StrictMode, useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { Icon, icons, Loading } from "./components/index.tsx"
import { get, post } from "./lib/api.ts"
import { ApiKeysPage } from "./pages/apikeys.tsx"
import { AudiencePage } from "./pages/audience.tsx"
import { AuthPage } from "./pages/auth.tsx"
import { AutomationsPage } from "./pages/automations.tsx"
import { BroadcastsPage } from "./pages/broadcasts.tsx"
import { DomainsPage } from "./pages/domains.tsx"
import { EmailsPage } from "./pages/emails.tsx"
import { IntegrationsPage } from "./pages/integrations.tsx"
import { LogsPage } from "./pages/logs.tsx"
import { MetricsPage } from "./pages/metrics.tsx"
import { SettingsPage } from "./pages/settings.tsx"
import { TemplatesPage } from "./pages/templates.tsx"
import { WebhooksPage } from "./pages/webhooks.tsx"

export const BASE = "/app"

export type Me = {
  object: "user"
  id: string
  email: string
  name: string | null
  is_owner: boolean
  team: { id: string; name: string; slug: string }
}

// ------------------------------------------------------------------ router --

export const navigate = (path: string) => {
  window.history.pushState({}, "", `${BASE}${path}`)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

const useRoute = (): string => {
  const read = () => {
    const path = window.location.pathname
    const stripped = path.startsWith(BASE) ? path.slice(BASE.length) : path
    return stripped === "" ? "/" : stripped
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onPop = () => setRoute(read())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  return route
}

const NAV = [
  { label: "Emails", path: "/emails", icon: icons.mail },
  { label: "Broadcasts", path: "/broadcasts", icon: icons.broadcast },
  { label: "Automations", path: "/automations", icon: icons.automation },
  { label: "Templates", path: "/templates", icon: icons.template },
  { label: "Audience", path: "/audience", icon: icons.audience },
  { label: "Metrics", path: "/metrics", icon: icons.metrics },
  { label: "Domains", path: "/domains", icon: icons.domain },
  { label: "Logs", path: "/logs", icon: icons.logs },
  { label: "API keys", path: "/api-keys", icon: icons.key },
  { label: "Webhooks", path: "/webhooks", icon: icons.webhook },
  { label: "Integrations", path: "/integrations", icon: icons.link },
  { label: "Settings", path: "/settings", icon: icons.settings },
] as const

const initials = (value: string): string =>
  value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("")

const Shell = ({ me, onSignOut }: { me: Me; onSignOut: () => void }) => {
  const route = useRoute()
  const active = NAV.find((n) => route.startsWith(n.path))

  const render = () => {
    if (route === "/" || route === "") return <EmailsPage />
    if (route.startsWith("/emails")) return <EmailsPage route={route} />
    if (route.startsWith("/broadcasts")) return <BroadcastsPage route={route} />
    if (route.startsWith("/automations")) return <AutomationsPage route={route} />
    if (route.startsWith("/templates")) return <TemplatesPage route={route} />
    if (route.startsWith("/audience")) return <AudiencePage route={route} />
    if (route.startsWith("/metrics")) return <MetricsPage />
    if (route.startsWith("/domains")) return <DomainsPage route={route} />
    if (route.startsWith("/logs")) return <LogsPage route={route} />
    if (route.startsWith("/api-keys")) return <ApiKeysPage />
    if (route.startsWith("/webhooks")) return <WebhooksPage route={route} />
    if (route.startsWith("/integrations")) return <IntegrationsPage />
    if (route.startsWith("/settings")) return <SettingsPage me={me} onSignOut={onSignOut} />
    return <EmailsPage />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="team">
          <div className="avatar">{initials(me.team.name)}</div>
          <div className="team-name">{me.team.name}</div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              type="button"
              key={item.path}
              className={`nav-item${active?.path === item.path ? " active" : ""}`}
              onClick={() => navigate(item.path)}
            >
              <Icon path={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="avatar" style={{ background: "linear-gradient(140deg,#334155,#475569)" }}>
            {initials(me.email)}
          </div>
          <div className="truncate muted" style={{ flex: 1, fontSize: 13 }}>
            {me.email}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <a
            className="muted"
            href="https://github.com/wess/outbox"
            target="_blank"
            rel="noreferrer noopener"
          >
            Docs
          </a>
          <button type="button" className="btn btn-sm" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <div className="content">{render()}</div>
      </main>
    </div>
  )
}

const App = () => {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)

  const load = useCallback(() => {
    get<Me>("/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setReady(true))
  }, [])

  useEffect(load, [load])

  const signOut = useCallback(async () => {
    await post("/auth/logout").catch(() => {})
    setMe(null)
    navigate("/emails")
  }, [])

  if (!ready) return <Loading />
  if (!me) return <AuthPage onAuthenticated={setMe} />
  return <Shell me={me} onSignOut={signOut} />
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
