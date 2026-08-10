import { useEffect, useState } from "react"
import type { Me } from "../app.tsx"
import { post } from "../lib/api.ts"

type Mode = "login" | "signup" | "forgot" | "reset"

/**
 * The reset link arrives by email and lands here while signed out, so the mode
 * has to come from the URL rather than from a button the visitor pressed.
 */
const tokenFromUrl = (): string | null => {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token")
  return token && window.location.pathname.includes("reset-password") ? token : null
}

export const AuthPage = ({ onAuthenticated }: { onAuthenticated: (me: Me) => void }) => {
  // Captured once, not recomputed: the effect below strips the token from the
  // address bar, and a value read fresh each render would go null underneath a
  // form still asking for the new password.
  const [resetToken] = useState(tokenFromUrl)
  const [mode, setMode] = useState<Mode>(resetToken ? "reset" : "login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [teamName, setTeamName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Leaving the token in the address bar means it survives in history and in
  // anything the browser syncs. It has been read into state by this point.
  useEffect(() => {
    if (!resetToken) return
    window.history.replaceState({}, "", window.location.pathname)
  }, [resetToken])

  const go = (next: Mode) => {
    setMode(next)
    setError(null)
    setNotice(null)
    setPassword("")
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === "forgot") {
        const res = await post<{ message: string }>("/auth/forgot-password", { email })
        setNotice(res.message)
      } else if (mode === "reset") {
        const res = await post<{ message: string }>("/auth/reset-password", {
          token: resetToken,
          password,
        })
        setNotice(res.message)
        setMode("login")
      } else if (mode === "login") {
        onAuthenticated(await post<Me>("/auth/login", { email, password }))
      } else {
        onAuthenticated(
          await post<Me>("/auth/signup", {
            email,
            password,
            team_name: teamName || undefined,
          }),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const heading =
    mode === "forgot" ? "Reset your password" : mode === "reset" ? "Choose a new password" : null

  const cta =
    mode === "forgot"
      ? "Send reset link"
      : mode === "reset"
        ? "Set new password"
        : mode === "login"
          ? "Sign in"
          : "Create account"

  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="brand">
          <span style={{ fontSize: 22 }}>📨</span> Outbox
        </div>

        {mode === "login" || mode === "signup" ? (
          <div className="tabs" style={{ justifyContent: "center" }}>
            <button
              type="button"
              className={`tab${mode === "login" ? " active" : ""}`}
              onClick={() => go("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`tab${mode === "signup" ? " active" : ""}`}
              onClick={() => go("signup")}
            >
              Create account
            </button>
          </div>
        ) : (
          <h2 style={{ textAlign: "center", fontSize: 18, margin: "8px 0 4px" }}>{heading}</h2>
        )}

        {mode === "forgot" ? (
          <p
            style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}
          >
            Enter your address and we'll send you a link.
          </p>
        ) : null}

        <form onSubmit={submit}>
          {mode !== "reset" ? (
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
          ) : null}

          {mode !== "forgot" ? (
            <div className="field">
              <label htmlFor="password">{mode === "reset" ? "New password" : "Password"}</label>
              <input
                id="password"
                className="input"
                type="password"
                value={password}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "login" ? undefined : 8}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          ) : null}

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
            {busy ? "Working…" : cta}
          </button>

          {error ? <div className="error-text">{error}</div> : null}
          {notice ? (
            <div
              className="muted"
              style={{ marginTop: 12, fontSize: 14, textAlign: "center", lineHeight: 1.5 }}
            >
              {notice}
            </div>
          ) : null}
        </form>

        <div style={{ marginTop: 16, textAlign: "center", fontSize: 14 }}>
          {mode === "login" ? (
            <button type="button" className="link-button" onClick={() => go("forgot")}>
              Forgot your password?
            </button>
          ) : mode !== "signup" ? (
            <button type="button" className="link-button" onClick={() => go("login")}>
              Back to sign in
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
