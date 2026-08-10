---
title: SDKs
description: Use the official Resend SDKs against Outbox, or the bundled zero-dependency client.
section: Reference
order: 40
---

# SDKs

## Use a Resend SDK

Outbox implements the Resend API, so every official Resend SDK works against it. Change
the base URL and nothing else.

### JavaScript / TypeScript

```ts
import { Resend } from "resend"

const resend = new Resend(process.env.OUTBOX_API_KEY, {
  baseUrl: "https://outbox.example.com",
})

const { data, error } = await resend.emails.send({
  from: "Acme <onboarding@acme.com>",
  to: ["user@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>",
})
```

This is verified rather than asserted: the repo's `bun run test:compat` runs the official
`resend` package against a live Outbox and checks sends, retrieval, listing, scheduling,
cancellation, batching, audiences, contacts, API keys, and error shapes.

### Python

```python
import resend

resend.api_key = os.environ["OUTBOX_API_KEY"]
resend.api_url = "https://outbox.example.com"

resend.Emails.send({
    "from": "Acme <onboarding@acme.com>",
    "to": ["user@example.com"],
    "subject": "Hello World",
    "html": "<strong>It works!</strong>",
})
```

### Ruby

```ruby
Resend.api_key = ENV["OUTBOX_API_KEY"]
Resend.base_url = "https://outbox.example.com"

Resend::Emails.send({
  from: "Acme <onboarding@acme.com>",
  to: ["user@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>"
})
```

### Go, PHP, Rust, Java, .NET, Elixir

Each exposes a base URL or client option. Set it to your Outbox host; the request and
response shapes are identical.

### SMTP

Not currently supported. Outbox speaks SMTP outbound and inbound, but does not accept
submission over SMTP — use the HTTP API.

## The bundled client

`@outbox/sdk` ships in the repo. Zero dependencies, functional, and it accepts keys in
either camelCase or snake_case.

```ts
import { createClient } from "@outbox/sdk"

const outbox = createClient({
  apiKey: process.env.OUTBOX_API_KEY!,
  baseUrl: "https://outbox.example.com",
})

const { data, error } = await outbox.emails.send({
  from: "Acme <onboarding@acme.com>",
  to: ["user@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>",
})
```

It returns `{ data, error }` rather than throwing, matching the Resend SDK's ergonomics:

```ts
if (error) {
  console.error(error.name, error.message)
} else {
  console.log(error === null && data.id)
}
```

### Surface

```ts
outbox.emails.send / get / list / update / cancel
outbox.emails.attachments.list / get
outbox.emails.received.list / get
outbox.emails.metrics
outbox.batch.send
outbox.domains.create / get / list / update / verify / remove
outbox.apiKeys.create / list / remove
outbox.segments.create / get / list / remove / contacts / metrics
outbox.audiences.create / get / list / remove
outbox.contacts.create / get / list / update / remove
outbox.contacts.topics.list / update
outbox.contacts.segments.list / add / remove
outbox.contactProperties.create / get / list / update / remove
outbox.topics.create / get / list / update / remove
outbox.broadcasts.create / get / list / update / send / remove / metrics / recipients
outbox.templates.create / get / list / update / publish / duplicate / remove
outbox.suppressions.add / get / list / remove
outbox.suppressions.batch.add / remove
outbox.webhooks.create / get / list / update / remove / verify
outbox.webhooks.events.list / get / attempts
outbox.automations.create / get / list / update / remove / runs / run
outbox.events.send
outbox.logs.list / get
```

### Idempotency

```ts
await outbox.emails.send(
  { from: "…", to: ["…"], subject: "…", html: "…" },
  { idempotencyKey: `order-${orderId}-confirmation` },
)
```

### Verifying webhooks

```ts
import { verifyWebhook } from "@outbox/sdk"

const event = await verifyWebhook({
  payload: rawBody,
  headers: {
    id: req.headers["svix-id"],
    timestamp: req.headers["svix-timestamp"],
    signature: req.headers["svix-signature"],
  },
  webhookSecret: process.env.OUTBOX_WEBHOOK_SECRET!,
})
```

Throws on a bad signature, a missing header, or a timestamp outside the five-minute
window. Uses Web Crypto, so it runs in Node, Bun, Deno, Cloudflare Workers, and the
browser — though not the browser, please.

Pass the **raw body**. Re-serialising parsed JSON changes the bytes and verification will
fail.

## Direct HTTP

There is nothing unusual about the API — bearer token, JSON, and a `User-Agent`:

```sh
curl -X POST https://outbox.example.com/emails \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <onboarding@acme.com>",
    "to": ["user@example.com"],
    "subject": "Hello World",
    "html": "<strong>It works!</strong>"
  }'
```
