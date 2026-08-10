# Outbox

Open source email API and dashboard. A self-hostable Resend.

Outbox implements the Resend API surface — same paths, same request bodies, same
response shapes, same error envelope — plus the dashboard that goes with it. Point
any Resend SDK at your Outbox host and it works unchanged.

Built on [Atlas](https://github.com/wess/atlas) and PostgreSQL. MIT licensed.

**[Documentation](https://wess.github.io/outbox)** · [Quickstart](https://wess.github.io/outbox/quickstart) · [API reference](https://wess.github.io/outbox/api/introduction) · [Migrate from Resend](https://wess.github.io/outbox/tutorials/migrate-from-resend) · [llms.txt](https://wess.github.io/outbox/llms.txt)

```ts
import { Resend } from "resend"

// The only change is the base URL.
const resend = new Resend("ob_yourapikey", { baseUrl: "https://outbox.yourdomain.com" })

await resend.emails.send({
  from: "Acme <onboarding@yourdomain.com>",
  to: ["someone@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>",
})
```

---

## What's in it

**Sending** — transactional email, batch send (100 per call), scheduling with
natural language (`in 1 hour`) or ISO 8601, attachments, inline images, custom
headers, tags, idempotency keys, and cancel/reschedule of queued sends.

**Domains** — per-domain DKIM keypairs, generated SPF/DKIM/DMARC/MX/tracking
records, live DNS verification, open and click tracking, custom return path,
opportunistic or enforced TLS.

**Audience** — contacts with typed custom properties, segments, topics with
per-contact opt-in/opt-out, and a suppression list that bounces feed
automatically.

**Broadcasts** — fan out to a segment with per-contact personalisation
(`{{{contact.first_name|there}}}`), scheduling, and per-broadcast metrics
including clicked links.

**Templates** — versioned, with typed variables and fallbacks, draft/publish
workflow, duplication, and addressing by id or alias.

**Automations** — event-triggered workflows as a step graph: conditions with
branching, delays, waiting on an event, sending email, and mutating contacts.

**Webhooks** — 19 event types, Svix-compatible signatures (the standard Svix
libraries verify Outbox payloads unchanged), delivery attempt history, and
exponential-backoff retries.

**Receiving** — an inbound SMTP server that parses MIME, stores attachments, and
fires `email.received`.

**Bounce handling** — DSN and ARF reports arriving at the VERP return path are
parsed, attributed to the message that caused them, classified hard or soft, and
fed into the suppression list. Works without enabling inbound mail.

**Accounts** — the first account on an instance is its owner; later signups get
their own team. Sessions are cookie-based and revocable.

**Integrations** — pair with [Inkling](https://github.com/wess/inkling) in one paste each
direction: the CMS gets outbound email and broadcast-on-publish, and Outbox can build a
broadcast straight from a published entry. See
[Connect Inkling](https://wess.github.io/outbox/tutorials/connect-inkling).

**Also** — API keys with full or send-only scope and optional domain restriction,
cursor pagination, per-team rate limiting, a full API request log, and metrics
with configurable granularity and dimensions.

---

## Quick start

Requires [Bun](https://bun.sh) 1.3+ and PostgreSQL 14+ (Docker is fine).

```sh
git clone https://github.com/wess/outbox.git
cd outbox
bun install

cp .env.example .env          # then edit JWT_SECRET
bun run db:up                 # starts Postgres on :55432
bun run migrate               # creates the schema
bun run seed                  # prints a starter team, login, and API key

bun run dev                   # API + worker on :3000
```

Open <http://localhost:3000/app> and sign in with the seeded credentials.

**The first account created on an instance owns it.** That is whoever `bun run seed`
creates, or the first person to sign up if you skip seeding. Ownership is enforced
by a partial unique index, so two simultaneous signups on a brand-new instance
cannot both claim it — one becomes the owner and the other becomes an ordinary
account. Later signups create their own team and are never the owner.

Send your first email:

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

With `OUTBOX_TRANSPORT=console` (the default) the message is printed to the
worker log rather than delivered, so you can try everything before you own a
domain.

---

## Delivering real mail

Outbox is not a proxy in front of SES — it delivers mail itself. Pick a transport:

| `OUTBOX_TRANSPORT` | Behaviour |
|---|---|
| `console` | Prints the message. The default, for development. |
| `relay` | Hands every message to one upstream SMTP server (SES, Postmark, your own Postfix). Easiest path to real delivery. |
| `smtp` | Talks to each recipient domain's MX hosts directly. No third party involved. |

`relay` needs `SMTP_RELAY_HOST` / `PORT` / `USER` / `PASS`.

`smtp` needs outbound port 25, a static IP with matching forward and reverse DNS,
and a warmed-up sending reputation. It is the most work and the least forgiving —
if you are not already comfortable running an MTA, use `relay`.

### Domain setup

Add a domain in the dashboard and Outbox generates a 1024-bit DKIM keypair and
the records to publish:

| Record | Type | Purpose |
|---|---|---|
| `@` and `send` | TXT | SPF authorising this host |
| `send` | MX | Return path for bounces |
| `outbox._domainkey` | TXT | DKIM public key |
| `_dmarc` | TXT | DMARC policy (starts at `p=none`) |
| `links` | CNAME | Click and open tracking (only when tracking is on) |
| `@` | MX | Inbound mail (only when receiving is on) |

Publish them, click **Verify DNS**, and the domain flips to `verified` once SPF
and DKIM resolve. Outbound mail is DKIM-signed from that point.

The record *values* differ from Resend's because they point at your installation
rather than at SES. The API shape is identical.

---

## Configuration

Everything is environment variables — see `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://outbox:outbox@localhost:55432/outbox` | |
| `JWT_SECRET` | — | Set this. Signs sessions and tracking tokens. |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:3000` | Used to build tracking and unsubscribe links. |
| `OUTBOX_TRANSPORT` | `console` | `console`, `relay`, or `smtp`. |
| `OUTBOX_HOSTNAME` | `localhost` | EHLO name and the host DNS records point at. |
| `INBOUND_ENABLED` | `false` | |
| `INBOUND_PORT` | `2525` | Put a forwarder from :25 in front in production. |
| `WORKER_CONCURRENCY` | `8` | Jobs in flight per worker. |
| `RATE_LIMIT_PER_SECOND` | `10` | Per team, matching Resend's default. |
| `MAX_ATTACHMENT_BYTES` | `41943040` | 40MB. |
| `TRUSTED_PROXIES` | — | Set when behind a load balancer so client IPs are real. |

### Connecting another service

```sh
bun run bin/outbox.ts connect            # prints a token to paste elsewhere
bun run bin/outbox.ts connect --send-only # a key that can only send
bun run bin/outbox.ts connect inkling <token>   # pair with an Inkling install
```

A connection token carries the URL and the API key in one string, so pairing is one paste
rather than two fields to get subtly wrong.

---

## Commands

```sh
bun run dev              # API + worker (+ inbound when enabled)
bun run api              # API and dashboard only
bun run worker           # background worker only
bun run inbound          # inbound SMTP server only

bun run migrate          # apply pending migrations
bun run migrate:status   # show migration state
bun run migrate:down     # roll back the most recent migration
bun run migrate:diff     # write a migration from schema drift

bun run seed             # create a starter team, user, and API key
bun test                 # unit tests
bun run typecheck        # tsc --noEmit
bun run tidy             # format and lint with Biome
```

---

## Architecture

A Bun workspace. Every package is functional — no classes, immutable data.

```
packages/
  config/     typed environment variables
  schema/     43 @atlas/db table definitions
  core/       domain logic: MIME, DKIM, templating, tracking, queue, auth,
              pagination, idempotency, serialisers
  api/        the Resend-compatible REST API + dashboard routes
  delivery/   SMTP client and the three transports
  worker/     send pipeline, broadcast fan-out, webhook delivery, automations
  inbound/    inbound SMTP server and MIME parser
  web/        React dashboard
  sdk/        JavaScript client
migrations/   SQL, hand-written for real indexes and foreign keys
```

The API and the dashboard share one process and one port. The API lives at the
root so SDK base-URL swaps work; the dashboard is served under `/app`.

Work that must not happen during a request — delivery, fan-out, webhook posts,
automation steps — goes through a Postgres-backed queue that workers claim with
`SELECT … FOR UPDATE SKIP LOCKED`. Run as many workers as you like.

### Notable details

- The dashboard authenticates with a session cookie against the *same* endpoints
  the public API exposes, so there is no second API to keep in sync.
- Cursor pagination compares `(created_at, id)` against a subquery rather than a
  round-tripped timestamp — a JS `Date` truncates Postgres microseconds and would
  leave the cursor row inside the range.
- Header values are stripped of control characters before they are written, so a
  newline in a subject or display name cannot inject a `Bcc`.
- `from` and `to` are reserved words in Postgres and `@atlas/db` emits bare
  identifiers, so those columns are `from_address` / `to_addresses` and the
  serialiser maps them back.

---

## API compatibility

Implemented, matching Resend's paths and shapes:

`/emails` (send, batch, get, update, cancel, list, metrics, attachments,
receiving) · `/domains` · `/api-keys` · `/broadcasts` (+ metrics, recipients) ·
`/contacts` (+ topics, segments) · `/contact-properties` · `/segments`
(and the `/audiences` alias) · `/topics` · `/suppressions` (+ batch) ·
`/templates` (+ publish, duplicate) · `/webhooks` (+ events, attempts) ·
`/logs` · `/events/send` · `/automations` (+ runs)

Errors use Resend's envelope:

```json
{ "statusCode": 422, "name": "missing_required_field", "message": "Missing `subject` field." }
```

Lists use Resend's envelope:

```json
{ "object": "list", "has_more": false, "data": [] }
```

### Differences

- **API keys** are prefixed `ob_` rather than `re_`.
- **DNS record values** point at your host, not SES. The record *set* is the same.
- **Billing** is not implemented — there is nothing to bill for. Usage counts are
  in the dashboard.
- **Regions** are stored and returned but do not route anywhere; a self-hosted
  install has one region.

---

## Testing

```sh
bun test                 # 108 unit tests, no server or database needed
bun run test:smoke       # API contract, against a running server
bun run test:e2e         # full pipeline, including a real webhook receiver
bun run test:compat      # the official `resend` npm package, against Outbox
```

The integration suites need `OUTBOX_API_KEY` set to a key from `bun run seed`.

The smoke suite walks every resource. The e2e suite drives the whole pipeline —
send, worker delivery, event emission, webhook delivery with signature
verification, suppression, topic gating, broadcast fan-out, and automation
branching — against a real webhook receiver it starts itself.

`test:compat` is the interesting one: it runs the *official* `resend` npm package
against Outbox with nothing changed but the base URL, which is what makes the
compatibility claim above checkable rather than aspirational.

---

## Documentation

The full docs live at **[wess.github.io/outbox](https://wess.github.io/outbox)** — API
reference for every endpoint, nine tutorials, and self-hosting guidance.

The source is markdown under `site/content/`, built by a small generator:

```sh
bun run docs:build     # renders site/content -> site/public
bun run docs:serve     # preview on :4321
```

`.github/workflows/pages.yml` builds and deploys it on every push to `main` that touches
`site/`. Set the repository's **Settings → Pages → Source** to **GitHub Actions** for
that to run. If you would rather serve from a branch, `./site/publish.sh` pushes the
build to `gh-pages` instead.

The site also emits [`llms.txt`](https://wess.github.io/outbox/llms.txt) and
`llms-full.txt`, and serves every page's raw markdown at `<url>.md`, so an agent can read
the docs without scraping HTML.

## License

MIT — see [LICENSE](LICENSE).

Outbox is an independent project and is not affiliated with or endorsed by Resend.
