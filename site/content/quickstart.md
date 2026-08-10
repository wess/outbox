---
title: Quickstart
description: Get Outbox running locally and send your first email in about five minutes.
section: Getting started
order: 1
---

# Quickstart

Outbox needs [Bun](https://bun.sh) 1.3 or newer and PostgreSQL 14 or newer. Docker is
the easiest way to get Postgres, and the repo ships a compose file for it.

## Install

```sh
git clone https://github.com/wess/outbox.git
cd outbox
bun install
```

## Configure

```sh
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string. It signs dashboard sessions
and the tokens embedded in tracking and unsubscribe links, so it must not stay at its
default:

```sh
openssl rand -hex 32
```

Everything else has a working default for local development. In particular
`OUTBOX_TRANSPORT=console`, which prints messages to the worker log instead of
delivering them — you can exercise the whole product before you own a domain.

## Start the database and migrate

```sh
bun run db:up      # Postgres on :55432, via Docker
bun run migrate    # creates the schema
bun run seed       # creates a team, a login, and an API key
```

`seed` prints credentials. Save the API key — it is hashed on write and never shown
again:

```
  team      Acme (0f8a...)
  owner     yes — this is the instance owner
  user      admin@outbox.local
  password  outbox-dev-password
  api key   ob_EXAMPLEKEYdonotusethisvalue123
```

> The first account created on an instance owns it. That is whoever `seed` creates, or
> the first person to sign up if you skip seeding.

## Run it

```sh
bun run dev
```

This starts the API and the background worker in one process:

```
[outbox] api        http://localhost:3000
[outbox] dashboard  http://localhost:3000/app
[outbox] worker worker-332b92ae started (concurrency 8, transport console)
```

Open <http://localhost:3000/app> and sign in.

## Send an email

```sh
curl -X POST http://localhost:3000/emails \
  -H "Authorization: Bearer ob_yourapikey" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <onboarding@example.com>",
    "to": ["someone@example.com"],
    "subject": "Hello World",
    "html": "<strong>It works!</strong>"
  }'
```

```json
{ "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }
```

The `User-Agent` header is required — Outbox rejects requests without one, exactly as
Resend does. Every official SDK sets it for you.

Watch the worker log and you'll see the rendered message, then check the Emails page in
the dashboard: the email moves from `queued` to `sent` to `delivered`.

## Use an SDK

Any Resend SDK works. In JavaScript:

```ts
import { Resend } from "resend"

const resend = new Resend(process.env.OUTBOX_API_KEY, {
  baseUrl: "http://localhost:3000",
})

const { data, error } = await resend.emails.send({
  from: "Acme <onboarding@example.com>",
  to: ["someone@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>",
})

if (error) console.error(error)
else console.log(data.id)
```

Outbox also ships its own zero-dependency client — see [SDK](/sdk).

## What's next

- [Send your first email](/tutorials/send-your-first-email) — the same flow with more explanation.
- [Verify a domain](/tutorials/verify-a-domain) — required before Outbox will deliver real mail.
- [Self-hosting](/self-hosting) — transports, deployment, and what running an MTA actually involves.
- [API reference](/api/introduction) — every endpoint.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | API + worker (+ inbound when enabled) |
| `bun run api` | API and dashboard only |
| `bun run worker` | Background worker only |
| `bun run inbound` | Inbound SMTP server only |
| `bun run migrate` | Apply pending migrations |
| `bun run migrate:status` | Show migration state |
| `bun run migrate:down` | Roll back the most recent migration |
| `bun run seed` | Create a starter team, user, and API key |
| `bun test` | Unit tests |
| `bun run test:smoke` | API contract, against a running server |
| `bun run test:e2e` | Full pipeline, including a webhook receiver |
| `bun run test:compat` | The official `resend` package, against Outbox |
