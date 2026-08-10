---
title: Webhooks
description: Event types, Svix-compatible signatures, delivery history, and retries.
section: API reference
order: 21
---

# Webhooks

Webhooks push events to your endpoint as they happen, so you do not have to poll.

## Create a webhook

```
POST /webhooks
```

```json
{
  "endpoint": "https://acme.com/webhooks/outbox",
  "events": ["email.delivered", "email.bounced", "email.complained"]
}
```

```json
{
  "object": "webhook",
  "id": "4dd369bc-aa82-4ff3-97de-514ae3000ee0",
  "endpoint": "https://acme.com/webhooks/outbox",
  "events": ["email.delivered", "email.bounced", "email.complained"],
  "status": "enabled",
  "signing_secret": "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  "created_at": "2026-04-08 00:11:13.110779+00"
}
```

The signing secret is returned on create, retrieve, and list, so it can be fetched again
if lost.

## Event types

| Group | Events |
|---|---|
| Sending | `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.scheduled`, `email.suppressed` |
| Engagement | `email.opened`, `email.clicked` |
| Receiving | `email.received` |
| Contacts | `contact.created`, `contact.updated`, `contact.deleted` |
| Domains | `domain.created`, `domain.updated`, `domain.deleted` |
| Suppressions | `suppression.added`, `suppression.removed` |

An unknown event type is rejected at create time rather than silently ignored.

## Payload

```json
{
  "type": "email.delivered",
  "created_at": "2026-02-22T23:41:12.126Z",
  "data": {
    "email_id": "56761188-7520-42d8-8898-ff6fc54ce618",
    "message_id": "<111-222-333@acme.com>",
    "from": "Acme <onboarding@acme.com>",
    "to": ["user@example.com"],
    "subject": "Sending this example",
    "created_at": "2026-02-22T23:41:11.894Z",
    "tags": { "category": "confirm_email" }
  }
}
```

Note that `tags` arrive as an object map here, while the send API takes and returns an
array of `{ name, value }`. That asymmetry is Resend's, kept for compatibility.

`email.clicked` adds the link; `email.bounced` adds the bounce type and message.

## Verifying signatures

Outbox signs with the Svix scheme, so the standard Svix libraries verify Outbox payloads
unchanged. Every request carries both header families:

```
svix-id: msg_2XcQ8vLpNrKmT3wYbZaFhJdEgV
svix-timestamp: 1740267672
svix-signature: v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
webhook-id: msg_2XcQ8vLpNrKmT3wYbZaFhJdEgV
webhook-timestamp: 1740267672
webhook-signature: v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
```

With the Svix library:

```ts
import { Webhook } from "svix"

const wh = new Webhook(process.env.OUTBOX_WEBHOOK_SECRET!)
const event = wh.verify(rawBody, {
  "svix-id": req.headers["svix-id"],
  "svix-timestamp": req.headers["svix-timestamp"],
  "svix-signature": req.headers["svix-signature"],
})
```

Or with the Outbox SDK:

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

> Verify against the **raw request body**. Parsing to JSON and re-serialising changes the
> bytes and the signature will not match. This is the single most common integration
> mistake.

The signature is HMAC-SHA256 over `${id}.${timestamp}.${body}` using the secret after
`whsec_`, Base64-decoded. Timestamps outside a five-minute window are rejected, which
blocks replay.

## Retries

Non-2xx responses and timeouts retry with exponential backoff:

```
5s → 30s → 5m → 30m → 2h → 5h → 10h → 24h
```

Eight attempts across roughly a day, then the event is marked `exhausted`. Requests time
out after 10 seconds, so acknowledge quickly and do the work asynchronously.

Your endpoint should be idempotent. A timeout after you processed the event still
retries, so the same `svix-id` can legitimately arrive twice.

## Delivery history

```
GET /webhooks/:webhook_id/events
GET /webhooks/:webhook_id/events/:event_id
GET /webhooks/:webhook_id/events/:event_id/attempts
```

Attempts record what actually happened:

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "object": "attempt",
      "id": "9c1f…",
      "http_status_code": 500,
      "response": "Internal Server Error",
      "sent_at": "2026-02-22T23:41:12.126Z"
    }
  ]
}
```

That response body is usually enough to debug an integration without adding logging on
your side.

## Manage

```
GET    /webhooks
PATCH  /webhooks/:webhook_id
DELETE /webhooks/:webhook_id
```

`PATCH` accepts `endpoint`, `events`, and `status` (`enabled` or `disabled`). Disabling
stops delivery without losing history — better than deleting while you fix an endpoint.

## Local development

Webhooks need a publicly reachable URL. Either tunnel:

```sh
ngrok http 3000
```

Or point the webhook at a local server, since a self-hosted Outbox can reach your
machine directly:

```ts
Bun.serve({
  port: 4000,
  fetch: async (req) => {
    console.log(JSON.parse(await req.text()))
    return new Response("ok")
  },
})
```

See [Handle webhooks](/tutorials/handle-webhooks) for a complete integration.
