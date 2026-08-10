#!/usr/bin/env bun
import { config } from "@outbox/config"
import { issueApiKey, slug } from "@outbox/core"
import { allColumns, closeDb, db } from "@outbox/core/db"
import { allSchemas, memberships, type Team, teams, type User, users } from "@outbox/schema"
import { hash } from "@wess/atlas/auth"
import { from } from "@wess/atlas/db"
import { migrate } from "@wess/atlas/migrate"

const MIGRATIONS = "./migrations"

const usage = () => {
  console.log(`outbox — open source email API

Usage: bun run bin/outbox.ts <command>

  api                Start the HTTP API and dashboard
  worker             Start the background worker (sending, webhooks, automations)
  inbound            Start the inbound SMTP server
  dev                Run api + worker together

  migrate up         Apply pending migrations
  migrate down       Roll back the most recent migration
  migrate status     Show migration state
  migrate diff       Write a migration from schema drift

  seed               Create a starter team, user, and API key
  help               Show this message
`)
}

const cmdMigrate = async (sub: string | undefined) => {
  const conn = db()
  switch (sub) {
    case "up": {
      const ran = await migrate.up(conn, MIGRATIONS)
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "no pending migrations")
      break
    }
    case "down": {
      const rolled = await migrate.down(conn, MIGRATIONS)
      console.log(rolled ? `rolled back: ${rolled}` : "nothing to roll back")
      break
    }
    case "status": {
      for (const row of await migrate.status(conn, MIGRATIONS)) {
        console.log(`${row.appliedAt ? "applied" : "pending"}  ${row.name}`)
      }
      break
    }
    case "diff": {
      const result = await migrate.diff(conn, allSchemas as never, { dir: MIGRATIONS })
      console.log(result.noop ? "schema in sync" : `wrote ${result.path}`)
      break
    }
    default:
      console.error("migrate: expected up | down | status | diff")
      process.exitCode = 1
  }
}

const cmdSeed = async () => {
  const conn = db()
  const email = process.env.SEED_EMAIL ?? "admin@outbox.local"
  const password = process.env.SEED_PASSWORD ?? "outbox-dev-password"
  const teamName = process.env.SEED_TEAM ?? "Acme"

  const existing = await conn.one(
    from(users)
      .select("id")
      .where((q) => q("email").equals(email)),
  )
  if (existing) {
    console.log(`user ${email} already exists — nothing to do`)
    return
  }

  const user = (await conn.one<User>({
    text: `INSERT INTO users (email, password_hash, name, email_verified_at, is_owner)
           VALUES ($1, $2, 'Admin', now(), NOT EXISTS (SELECT 1 FROM users))
           RETURNING *`,
    values: [email, await hash(password)],
  }))!
  const team = (await conn.one<Team>(
    from(teams)
      .insert({ name: teamName, slug: `${slug(teamName)}-${user.id.slice(0, 6)}` })
      .returning(...allColumns(teams)),
  ))!
  await conn.execute(
    from(memberships).insert({ team_id: team.id, user_id: user.id, role: "owner" }),
  )

  const key = await issueApiKey({ teamId: team.id, name: "Default", createdBy: user.id })

  console.log(`
  team      ${team.name} (${team.id})
  owner     ${user.is_owner ? "yes — this is the instance owner" : "no — an owner already exists"}
  user      ${email}
  password  ${password}
  api key   ${key.token}

  Save the API key — it is not shown again.
`)
}

const main = async () => {
  const [command, sub] = process.argv.slice(2)

  switch (command) {
    case "api": {
      const { startApi } = await import("@outbox/api")
      startApi()
      return
    }
    case "worker": {
      const { startWorker } = await import("@outbox/worker")
      await startWorker()
      return
    }
    case "inbound": {
      const { startInbound } = await import("@outbox/inbound")
      await startInbound()
      return
    }
    case "dev": {
      const [{ startApi }, { startWorker }] = await Promise.all([
        import("@outbox/api"),
        import("@outbox/worker"),
      ])
      startApi()
      await startWorker()
      if (config.inbound.enabled) {
        const { startInbound } = await import("@outbox/inbound")
        await startInbound()
      }
      return
    }
    case "migrate":
      await cmdMigrate(sub)
      break
    case "seed":
      await cmdSeed()
      break
    case "help":
    case undefined:
      usage()
      break
    default:
      console.error(`unknown command: ${command}`)
      usage()
      process.exitCode = 1
  }

  await closeDb()
}

await main()
