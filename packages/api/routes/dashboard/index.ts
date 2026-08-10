import { config } from "@outbox/config"
import {
  consumePasswordReset,
  invalidParameter,
  issueSession,
  listEnvelope,
  normalizeEmail,
  notFound,
  pgTimestamp,
  requestPasswordReset,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  slug,
  unauthorizedDashboard,
} from "@outbox/core"
import { allColumns, db } from "@outbox/core/db"
import { memberships, type Team, teams, type User, users } from "@outbox/schema"
import { hash, verify } from "@wess/atlas/auth"
import { from } from "@wess/atlas/db"
import { type Conn, getR, json, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { ipOf } from "../../pipes/index.ts"

const cookie = (value: string, maxAge: number): string =>
  [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    config.publicUrl.startsWith("https://") ? "Secure" : "",
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ")

const withCookie = (conn: Conn, value: string, maxAge: number): Conn => ({
  ...conn,
  respHeaders: new Headers([...conn.respHeaders, ["set-cookie", cookie(value, maxAge)]]),
})

const userObject = (user: User, team: Team) => ({
  object: "user" as const,
  id: user.id,
  email: user.email,
  name: user.name,
  avatar_url: user.avatar_url,
  totp_enabled: user.totp_enabled,
  is_owner: user.is_owner,
  created_at: pgTimestamp(user.created_at),
  team: { id: team.id, name: team.name, slug: team.slug },
})

const teamOf = async (userId: string): Promise<Team> => {
  const team = await db().one<Team>({
    text: `SELECT t.* FROM teams t
           JOIN memberships m ON m.team_id = t.id
           WHERE m.user_id = $1
           ORDER BY m.created_at
           LIMIT 1`,
    values: [userId],
  })
  if (!team) throw notFound("No team found for this user")
  return team
}

const requireUser = async (conn: Conn): Promise<{ userId: string; teamId: string }> => {
  const session = await resolveSession(conn.headers.get("cookie"))
  if (!session) throw unauthorizedDashboard()
  return session
}

export const dashboardRoutes: Route[] = [
  postR(
    "/auth/signup",
    {
      body: z.object({
        email: z.string().email(),
        password: z.string().min(8, "Password must be at least 8 characters"),
        name: z.string().optional(),
        team_name: z.string().optional(),
      }),
    },
    async (c) => {
      const email = normalizeEmail(c.body.email)
      const existing = await db().one(
        from(users)
          .select("id")
          .where((q) => q("email").equals(email)),
      )
      if (existing) throw invalidParameter("An account with this email already exists.")

      const passwordHash = await hash(c.body.password)
      const insertUser = (claimOwner: boolean) =>
        db().one<User>({
          text: `INSERT INTO users (email, password_hash, name, email_verified_at, is_owner)
                 VALUES ($1, $2, $3, now(), ${claimOwner ? "NOT EXISTS (SELECT 1 FROM users)" : "false"})
                 RETURNING *`,
          values: [email, passwordHash, c.body.name ?? null],
        })

      // `NOT EXISTS` is evaluated inside the INSERT, so the first row to commit
      // owns the instance and the partial unique index rejects any second claim.
      // Two signups racing on an empty instance is the only way to hit that, and
      // the one that loses should still get an account — just not ownership.
      let user: User
      try {
        user = (await insertUser(true))!
      } catch (err) {
        const code = (err as { errno?: string; code?: string }).errno
        const constraint = (err as { constraint?: string }).constraint
        if (code !== "23505" || constraint !== "users_single_owner_idx") throw err
        user = (await insertUser(false))!
      }

      const teamName = c.body.team_name ?? c.body.name ?? email.split("@")[0]!
      const team = (await db().one<Team>(
        from(teams)
          .insert({ name: teamName, slug: `${slug(teamName)}-${user.id.slice(0, 6)}` })
          .returning(...allColumns(teams)),
      ))!
      await db().execute(
        from(memberships).insert({ team_id: team.id, user_id: user.id, role: "owner" }),
      )

      const session = await issueSession(user.id, {
        ip: ipOf(c as Conn),
        userAgent: c.headers.get("user-agent"),
      })
      return withCookie(json(c, 201, userObject(user, team)), session.token, SESSION_TTL_SECONDS)
    },
  ),

  postR(
    "/auth/login",
    { body: z.object({ email: z.string().email(), password: z.string().min(1) }) },
    async (c) => {
      const email = normalizeEmail(c.body.email)
      const user = await db().one<User>(from(users).where((q) => q("email").equals(email)))
      // Same message either way so the endpoint does not confirm which emails exist.
      const invalid = () => invalidParameter("Invalid email or password.")
      if (!user?.password_hash) throw invalid()
      if (!(await verify(c.body.password, user.password_hash))) throw invalid()

      const team = await teamOf(user.id)
      const session = await issueSession(user.id, {
        ip: ipOf(c as Conn),
        userAgent: c.headers.get("user-agent"),
      })
      return withCookie(json(c, 200, userObject(user, team)), session.token, SESSION_TTL_SECONDS)
    },
  ),

  postR("/auth/forgot-password", { body: z.object({ email: z.string().email() }) }, async (c) => {
    // Always the same answer, whatever happened. Anything else turns this
    // into an account-enumeration oracle on an endpoint that needs no
    // credentials — "no account with that address" is exactly the fact an
    // attacker came here to learn. The operator gets the detail in the log.
    const outcome = await requestPasswordReset({
      email: c.body.email,
      ip: ipOf(c as Conn),
    })
    if (!outcome.sent) console.log(`[outbox] password reset not sent — ${outcome.reason}`)

    return json(c, 202, {
      object: "password_reset",
      message: "If an account exists for that address, a reset link is on its way.",
    })
  }),

  postR(
    "/auth/reset-password",
    { body: z.object({ token: z.string().min(1), password: z.string().min(8) }) },
    async (c) => {
      await consumePasswordReset(c.body.token, c.body.password)
      // Deliberately no session: every session for the account was just
      // revoked, and signing the caller straight in would mean a leaked link
      // grants access without ever proving they can read the mailbox again.
      return json(c, 200, {
        object: "password_reset",
        message: "Password updated. You can sign in now.",
      })
    },
  ),

  postR("/auth/logout", {}, async (c) => {
    const session = await resolveSession(c.headers.get("cookie"))
    if (session) await revokeSession(session.jti)
    return withCookie(json(c, 200, { object: "session", revoked: true }), "", 0)
  }),

  getR("/auth/me", {}, async (c) => {
    const { userId } = await requireUser(c as Conn)
    const user = await db().one<User>(from(users).where((q) => q("id").equals(userId)))
    if (!user) throw unauthorizedDashboard()
    return json(c, 200, userObject(user, await teamOf(user.id)))
  }),

  getR("/team/members", {}, async (c) => {
    const { teamId } = await requireUser(c as Conn)
    const rows = await db().all<{
      id: string
      email: string
      name: string | null
      role: string
      created_at: Date
    }>({
      text: `SELECT u.id, u.email, u.name, m.role, m.created_at
             FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.team_id = $1 ORDER BY m.created_at`,
      values: [teamId],
    })
    return json(
      c,
      200,
      listEnvelope(
        rows.map((r) => ({
          object: "member",
          id: r.id,
          email: r.email,
          name: r.name,
          role: r.role,
          created_at: pgTimestamp(r.created_at),
        })),
      ),
    )
  }),

  // Counts for the dashboard home, in one round trip.
  getR("/dashboard/summary", {}, async (c) => {
    const { teamId } = await requireUser(c as Conn)
    const row = await db().one<Record<string, string>>({
      text: `SELECT
        (SELECT count(*) FROM emails WHERE team_id = $1) AS emails,
        (SELECT count(*) FROM emails WHERE team_id = $1 AND last_event = 'delivered') AS delivered,
        (SELECT count(*) FROM emails WHERE team_id = $1 AND last_event IN ('bounced','failed')) AS failed,
        (SELECT count(*) FROM contacts WHERE team_id = $1) AS contacts,
        (SELECT count(*) FROM domains WHERE team_id = $1) AS domains,
        (SELECT count(*) FROM domains WHERE team_id = $1 AND status = 'verified') AS verified_domains,
        (SELECT count(*) FROM broadcasts WHERE team_id = $1) AS broadcasts,
        (SELECT count(*) FROM templates WHERE team_id = $1) AS templates,
        (SELECT count(*) FROM segments WHERE team_id = $1) AS segments,
        (SELECT count(*) FROM suppressions WHERE team_id = $1) AS suppressions,
        (SELECT count(*) FROM webhooks WHERE team_id = $1) AS webhooks,
        (SELECT count(*) FROM automations WHERE team_id = $1) AS automations,
        (SELECT count(*) FROM api_keys WHERE team_id = $1) AS api_keys,
        (SELECT count(*) FROM jobs WHERE team_id = $1 AND status = 'pending') AS queued_jobs`,
      values: [teamId],
    })
    const counts = Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]))
    return json(c, 200, { object: "summary", ...counts })
  }),
]
