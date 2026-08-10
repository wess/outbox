---
title: Self-hosting
description: Transports, configuration, deployment, and the operational realities of running your own mail.
section: Getting started
order: 3
---

# Self-hosting

Outbox delivers mail itself rather than fronting a provider. That is the point of it,
and it is also the part that takes real work. This page is about that work.

## Choosing a transport

`OUTBOX_TRANSPORT` decides how mail leaves the building.

| Value | Behaviour | Use it when |
|---|---|---|
| `console` | Prints the message, delivers nothing | Local development, CI |
| `relay` | Hands every message to one upstream SMTP server | You want real delivery without running an MTA |
| `smtp` | Connects to each recipient domain's MX hosts directly | You want no third party in the path |

### console

The default. Messages are rendered fully — MIME built, tracking applied, unsubscribe
links injected — then printed instead of sent. Events still fire, so webhooks and
metrics behave as they would in production.

### relay

Hands off to an SMTP server you already trust: SES, Postmark, a corporate smarthost, or
your own Postfix.

```sh
OUTBOX_TRANSPORT=relay
SMTP_RELAY_HOST=email-smtp.us-east-1.amazonaws.com
SMTP_RELAY_PORT=587
SMTP_RELAY_USER=...
SMTP_RELAY_PASS=...
SMTP_RELAY_SECURE=starttls   # none | starttls | tls
```

This is the pragmatic choice for most self-hosters. You keep your data and the API, and
you let someone else own IP reputation.

### smtp

Resolves MX records for each recipient domain and delivers directly, upgrading to TLS
when the receiver offers STARTTLS.

```sh
OUTBOX_TRANSPORT=smtp
OUTBOX_HOSTNAME=mail.example.com
```

Before choosing this, be honest about the requirements:

- **Outbound port 25.** Most cloud providers block it by default and some will not
  unblock it at all. Check before you build a plan around it.
- **A static IP with matching forward and reverse DNS.** `mail.example.com` must resolve
  to your IP and that IP's PTR record must resolve back. Receivers reject mail from
  hosts that fail this.
- **Reputation.** A new IP has none. Volume ramps over weeks, not hours.
- **Someone to watch it.** Blocklists, feedback loops, and bounce handling are ongoing
  work, not setup steps.

If that list is unwelcome, use `relay`. It is not a lesser option; it is the correct
trade for most deployments.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://outbox:outbox@localhost:55432/outbox` | |
| `JWT_SECRET` | — | **Set this.** Signs sessions and tracking tokens. |
| `PORT` | `3000` | |
| `PUBLIC_URL` | `http://localhost:3000` | Builds tracking and unsubscribe links. Must be the externally reachable URL. |
| `OUTBOX_TRANSPORT` | `console` | `console`, `relay`, `smtp` |
| `OUTBOX_HOSTNAME` | `localhost` | EHLO name, and the host DNS records point at |
| `SMTP_RELAY_HOST` | — | Relay transport |
| `SMTP_RELAY_PORT` | `587` | |
| `SMTP_RELAY_USER` | — | |
| `SMTP_RELAY_PASS` | — | |
| `SMTP_RELAY_SECURE` | `starttls` | `none`, `starttls`, `tls` |
| `INBOUND_ENABLED` | `false` | |
| `INBOUND_PORT` | `2525` | Forward :25 to it rather than running as root |
| `WORKER_CONCURRENCY` | `8` | Jobs in flight per worker |
| `WORKER_POLL_MS` | `1000` | Queue poll interval |
| `RATE_LIMIT_PER_SECOND` | `10` | Per team, matching Resend's default |
| `MAX_ATTACHMENT_BYTES` | `41943040` | 40MB |
| `TRUSTED_PROXIES` | — | Set behind a load balancer so client IPs are real |
| `STORAGE_BUCKET` | — | Set to move attachments out of Postgres. See below |
| `STORAGE_REGION` | `us-east-1` | |
| `STORAGE_ENDPOINT` | — | Leave empty for AWS; set it for Spaces, R2, MinIO |
| `STORAGE_ACCESS_KEY_ID` | — | |
| `STORAGE_SECRET_ACCESS_KEY` | — | |
| `STORAGE_PREFIX` | `outbox` | Key prefix, so one bucket can hold other things |

`TRUSTED_PROXIES` matters more than it looks. Outbox only honours `X-Forwarded-For` when
the request genuinely arrived from a listed proxy; otherwise the header is
attacker-controlled and would let anyone forge their IP past the rate limiter.

## Running the pieces

`bun run dev` runs everything in one process, which is fine for a single box. To scale,
run them separately:

```sh
bun run api        # stateless, run as many as you like behind a load balancer
bun run worker     # run as many as you like; they coordinate through Postgres
bun run inbound    # one per host that MX records point at
```

Workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`, so adding workers needs no
configuration and no leader election.

## Behind a reverse proxy

Terminate TLS in front and forward to the API. Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name outbox.example.com;

  ssl_certificate     /etc/letsencrypt/live/outbox.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/outbox.example.com/privkey.pem;

  client_max_body_size 50m;   # attachments

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then set:

```sh
PUBLIC_URL=https://outbox.example.com
TRUSTED_PROXIES=127.0.0.1
```

## Receiving mail

Set `INBOUND_ENABLED=true` and enable receiving on the domain.

> The inbound server is also what processes **bounces**, and that does not need
> receiving enabled on the domain — see [Handle
> bounces](/tutorials/handle-bounces). On the `smtp` transport, running without
> it means asynchronous bounces are never seen and dead addresses are never
> suppressed. Outbox listens on
`INBOUND_PORT` (2525 by default) so it need not run as root; forward port 25 to it:

```sh
iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
```

Publish an MX record for the domain pointing at `inbound.<OUTBOX_HOSTNAME>`. Mail for
addresses on that domain is parsed, stored with its attachments, and raises
`email.received`.

See [Receive inbound email](/tutorials/receive-inbound-email).

## Object storage

By default everything lives in Postgres, attachments included. That is the right
default — one thing to run, one thing to back up — but attachments are unlike
everything else Outbox stores. A single 40MB attachment is larger than most teams'
entire `emails` table, and base64 in a `text` column costs a third again on top.
Send enough of them and the blobs dominate the database, every `pg_dump` carries
them, and the disk fills long before the row count gets interesting.

Point Outbox at a bucket and they go there instead, with Postgres keeping a key:

```sh
STORAGE_BUCKET=my-bucket
STORAGE_REGION=nyc3
STORAGE_ENDPOINT=https://nyc3.digitaloceanspaces.com   # empty for AWS S3
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
```

Any S3-compatible endpoint works — AWS, DigitalOcean Spaces, Cloudflare R2, MinIO,
Backblaze B2. Give the key **read and write on that one bucket**, not full access.

What moves: attachments on sent mail, attachments on received mail, and the raw
MIME of received messages. Keys are namespaced `<prefix>/<kind>/<team id>/<uuid>/
<filename>`, so one bucket serves every team and a team's objects can be found
without consulting the database.

Three things worth knowing:

- **It is not a cutover.** Rows written before you configured a bucket keep their
  inline content and stay readable. Nothing backfills them and nothing needs to —
  the read path takes whichever column is populated.
- **Turning it off strands anything already uploaded.** The objects survive, but an
  attachment with a key and no bucket configured is an error rather than an empty
  file, because silently sending a zero-byte attachment is worse than failing.
- **The bucket becomes part of your backup.** `pg_dump` alone is no longer a
  complete backup once blobs live elsewhere.

## Backups

Everything lives in Postgres — message bodies, DKIM private keys, and attachments
too unless you configured object storage above. A standard `pg_dump` is a complete
backup of the database.

Two things deserve attention:

- **DKIM private keys** are in `domains.dkim_private_key`. Losing them means republishing
  DNS for every domain. Treat the dump as a secret.
- **Attachments make the database large** when they are stored inline. If you send many
  or large attachments, either configure a bucket or plan retention accordingly.

## Housekeeping

Some tables grow without bound and nothing prunes them automatically, deliberately —
retention is your policy, not ours:

| Table | Grows with | Suggested |
|---|---|---|
| `api_logs` | Every API request | Keep 30 days |
| `email_events` | Every state change | Keep as long as you want metrics |
| `webhook_events` / `webhook_attempts` | Every event delivered | Keep 30 days |
| `jobs` | Completed jobs | Delete `status = 'done'` older than a few days |
| `rate_limits` | One row per bucket | Sweep windows older than your longest |

```sql
DELETE FROM api_logs WHERE created_at < now() - interval '30 days';
DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '3 days';
```

## Health

`GET /health` needs no authentication and checks database reachability:

```json
{ "status": "ok", "version": "0.1.0" }
```

It returns 503 with `"status": "degraded"` when Postgres is unreachable, which makes it
suitable as a load balancer check.

## Upgrading

```sh
git pull
bun install
bun run migrate
```

Migrations are forward-only in practice; `migrate:down` rolls back exactly one and is
meant for development. Take a dump before upgrading production.
