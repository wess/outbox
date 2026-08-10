---
title: Deploy to production
description: Docker, systemd, TLS, scaling, and a pre-flight checklist.
section: Tutorials
order: 38
---

# Deploy to production

Outbox is two long-running processes — an API and a worker — plus PostgreSQL. Nothing
exotic. This walks through a single-server deployment you can grow from.

## Docker Compose

```yaml
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: outbox
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: outbox
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U outbox"]
      interval: 10s
      retries: 5

  api:
    build: .
    restart: unless-stopped
    command: bun run bin/outbox.ts api
    env_file: .env
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      postgres: { condition: service_healthy }

  worker:
    build: .
    restart: unless-stopped
    command: bun run bin/outbox.ts worker
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }

volumes:
  pgdata:
```

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
CMD ["bun", "run", "bin/outbox.ts", "api"]
```

Run migrations as a one-off before starting:

```sh
docker compose run --rm api bun run bin/outbox.ts migrate up
docker compose up -d
```

## systemd

If you would rather not containerise:

```ini
# /etc/systemd/system/outbox-api.service
[Unit]
Description=Outbox API
After=network.target postgresql.service

[Service]
Type=simple
User=outbox
WorkingDirectory=/opt/outbox
EnvironmentFile=/opt/outbox/.env
ExecStart=/usr/local/bin/bun run bin/outbox.ts api
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Copy it to `outbox-worker.service` with `ExecStart=… worker`, then:

```sh
systemctl enable --now outbox-api outbox-worker
```

## TLS and the reverse proxy

```nginx
server {
  listen 443 ssl http2;
  server_name outbox.acme.com;

  ssl_certificate     /etc/letsencrypt/live/outbox.acme.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/outbox.acme.com/privkey.pem;

  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then:

```sh
PUBLIC_URL=https://outbox.acme.com
TRUSTED_PROXIES=127.0.0.1
```

`TRUSTED_PROXIES` matters. Outbox only honours `X-Forwarded-For` from a listed proxy;
otherwise the header is attacker-supplied and anyone could forge their IP past the rate
limiter.

`client_max_body_size` must exceed `MAX_ATTACHMENT_BYTES` after Base64 overhead — Base64
adds about a third.

## Scaling

**API** is stateless. Run several behind the load balancer.

**Workers** coordinate through Postgres with `SELECT … FOR UPDATE SKIP LOCKED`. Add more
processes; no configuration, no leader election.

```sh
docker compose up -d --scale worker=4
```

Raise `WORKER_CONCURRENCY` for more parallelism per worker. The practical ceiling is your
database connection count and, on the `smtp` transport, how fast receiving servers accept.

Watch the queue:

```sql
SELECT kind, status, count(*) FROM jobs GROUP BY kind, status;
```

A `pending` count that climbs and never falls means workers are down or too few.

## Backups

Everything is in Postgres, including message bodies, attachments, and **DKIM private
keys**.

```sh
pg_dump -Fc outbox > outbox-$(date +%F).dump
```

Automate it, store it off the box, and test a restore. Treat the dump as a secret: it
contains your customers' mail and the keys that authenticate your domains.

## Housekeeping

Nothing prunes automatically. A nightly cron:

```sql
DELETE FROM api_logs WHERE created_at < now() - interval '30 days';
DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '3 days';
DELETE FROM webhook_events WHERE created_at < now() - interval '30 days';
DELETE FROM rate_limits WHERE window_started_at < now() - interval '1 day';
```

Keep `email_events` as long as you want metrics — it is what they aggregate over.

## Monitoring

`GET /health` needs no auth and checks the database:

```json
{ "status": "ok", "version": "0.1.0" }
```

Returns 503 when Postgres is unreachable, so it works as a load balancer check.

Worth alerting on:

| Signal | Query | Meaning |
|---|---|---|
| Queue depth | `count(*) FROM jobs WHERE status='pending'` | Workers down or overloaded |
| Failed jobs | `count(*) FROM jobs WHERE status='failed'` | Something is systematically broken |
| Bounce rate | `/emails/metrics?metrics=bounce_rate` | List quality or reputation |
| Complaint rate | `/emails/metrics?metrics=complaint_rate` | Above 0.1%, act |
| Exhausted webhooks | `count(*) FROM webhook_events WHERE status='exhausted'` | A consumer is down |

## Pre-flight checklist

- [ ] `JWT_SECRET` is long and random, not the default
- [ ] `PUBLIC_URL` is the externally reachable HTTPS URL
- [ ] `TRUSTED_PROXIES` set if behind a proxy
- [ ] Postgres is not exposed to the internet
- [ ] Migrations applied; `migrate diff` reports "schema in sync"
- [ ] Transport chosen and tested end to end
- [ ] At least one domain verified, SPF/DKIM/DMARC passing at Gmail
- [ ] Suppression list imported, if migrating
- [ ] Backups automated **and a restore tested**
- [ ] Retention cron installed
- [ ] Health check wired to the load balancer
- [ ] Alerting on queue depth
- [ ] The instance owner account is one you control

## Upgrading

```sh
git pull
bun install
bun run migrate
docker compose up -d --build
```

Take a dump first. Migrations are forward-only in practice — `migrate:down` rolls back
exactly one and is meant for development.

The API is stateless, so a rolling restart drops no requests. Workers finish in-flight
jobs on shutdown; anything interrupted is reclaimed after five minutes and retried.
