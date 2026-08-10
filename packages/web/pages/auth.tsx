import { useState } from "react"
import type { Me } from "../app.tsx"
import { post } from "../lib/api.ts"

export const AuthPage = ({ onAuthenticated }: { onAuthenticated: (me: Me) => void }) => {
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [teamName, setTeamName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const me =
        mode === "login"
          ? await post<Me>("/auth/login", { email, password })
          : await post<Me>("/auth/signup", { email, password, team_name: teamName || undefined })
      onAuthenticated(me)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="brand">
          <span style={{ fontSize: 22 }}>📨</span> Outbox
        </div>

        <div className="tabs" style={{ justifyContent: "center" }}>
          <button
            type="button"
            className={`tab${mode === "login" ? " active" : ""}`}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`tab${mode === "signup" ? " active" : ""}`}
            onClick={() => setMode("signup")}
          >
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {mode === "signup" ? (
            <div className="field">
              <label htmlFor="team">Team name</label>
              <input
                id="team"
                className="input"
                value={teamName}
                placeholder="Acme"
                onChange={(e) => setTeamName(e.target.value)}
              />
            </div>
          ) : null}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={busy}
          >
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </button>

          {error ? <div className="error-text">{error}</div> : null}
        </form>
      </div>
    </div>
  )
}
