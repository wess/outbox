---
title: Handle webhooks
description: Receive events, verify signatures correctly, and react to bounces and complaints.
section: Tutorials
order: 36
---

# Handle webhooks

Polling for delivery status does not scale and does not tell you about opens, clicks, or
complaints. Webhooks do.

## 1. Build the endpoint

The critical detail: **verify against the raw body**. Frameworks that parse JSON for you
will break the signature, because re-serialising changes the bytes.

### Bun

```ts
import { verifyWebhook } from "@outbox/sdk"

Bun.serve({
  port: 4000,
  routes: {
    "/webhooks/outbox": {
      POST: async (req) => {
        const raw = await req.text()

        let event: any
        try {
          event = await verifyWebhook({
            payload: raw,
            headers: {
              id: req.headers.get("svix-id"),
              timestamp: req.headers.get("svix-timestamp"),
              signature: req.headers.get("svix-signature"),
            },
            webhookSecret: process.env.OUTBOX_WEBHOOK_SECRET!,
          })
        } catch (err) {
          return new Response("invalid signature", { status: 400 })
        }

        // Acknowledge immediately; do the work out of band.
        queueMicrotask(() => handle(event).catch(console.error))
        return new Response("ok")
      },
    },
  },
})
```

### Express

```ts
import express from "express"
import { Webhook } from "svix"

const app = express()

// express.raw, not express.json — the parsed body cannot be verified.
app.post("/webhooks/outbox", express.raw({ type: "application/json" }), (req, res) => {
  const wh = new Webhook(process.env.OUTBOX_WEBHOOK_SECRET!)

  let event
  try {
    event = wh.verify(req.body, {
      "svix-id": req.header("svix-id")!,
      "svix-timestamp": req.header("svix-timestamp")!,
      "svix-signature": req.header("svix-signature")!,
    })
  } catch {
    return res.status(400).send("invalid signature")
  }

  res.send("ok")
  handle(event).catch(console.error)
})
```

### Next.js App Router

```ts
export async function POST(req: Request) {
  const raw = await req.text()
  // …verify as above
}
```

## 2. Register it

```sh
curl -X POST https://outbox.example.com/webhooks \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "https://acme.com/webhooks/outbox",
    "events": ["email.delivered", "email.bounced", "email.complained", "email.opened", "email.clicked"]
  }'
```

The response includes `signing_secret` — put it in your environment.

Subscribe only to what you act on. `email.sent` fires for every message and is rarely
useful; `email.bounced` and `email.complained` always are.

## 3. Handle the events

```ts
const handle = async (event: { type: string; data: any }) => {
  switch (event.type) {
    case "email.bounced": {
      const hard = event.data.bounce?.type === "Permanent"
      await db.emails.update(event.data.email_id, {
        status: "bounced",
        bounceType: hard ? "hard" : "soft",
      })
      // Outbox already suppressed hard bounces. Mirror it locally so your own
      // sending decisions know too.
      if (hard) await db.users.markEmailInvalid(event.data.to[0])
      break
    }

    case "email.complained":
      // Someone marked it as spam. Stop all marketing to them, immediately.
      await db.users.unsubscribeAll(event.data.to[0])
      break

    case "email.delivered":
      await db.emails.update(event.data.email_id, { status: "delivered" })
      break

    case "email.clicked":
      await analytics.track("email_clicked", {
        email_id: event.data.email_id,
        url: event.data.link?.url,
      })
      break
  }
}
```

## 4. Make it idempotent

Outbox retries on timeouts, so an event you already processed can arrive again. Key on
`svix-id`:

```ts
const seen = await db.webhookEvents.findUnique({ where: { id: svixId } })
if (seen) return new Response("ok")
await db.webhookEvents.create({ data: { id: svixId, type: event.type } })
```

Without this, a slow response on your side turns into duplicate work on every retry.

## 5. Respond fast

Requests time out after **10 seconds**. Acknowledge first, then work:

```ts
res.send("ok")
processInBackground(event)
```

Doing database writes, third-party calls, and image processing before responding is how
endpoints end up in retry loops.

## Retries

Non-2xx and timeouts retry with backoff:

```
5s → 30s → 5m → 30m → 2h → 5h → 10h → 24h
```

Eight attempts over roughly a day, then `exhausted`. Every attempt is recorded:

```sh
curl https://outbox.example.com/webhooks/$WEBHOOK_ID/events/$EVENT_ID/attempts \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{
  "data": [
    { "http_status_code": 500, "response": "Internal Server Error", "sent_at": "…" },
    { "http_status_code": 200, "response": "ok", "sent_at": "…" }
  ]
}
```

Your own error message comes back in `response`, which usually removes the need for
extra logging while debugging.

## Local development

Because Outbox is yours, it can reach your machine directly — no tunnel needed if both
are on the same network:

```ts
Bun.serve({
  port: 4000,
  fetch: async (req) => {
    console.log(await req.text())
    return new Response("ok")
  },
})
```

```sh
curl -X POST http://localhost:3000/webhooks \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "endpoint": "http://localhost:4000/hook", "events": ["email.sent"] }'
```

Otherwise `ngrok http 4000` and register the public URL.

## Common mistakes

**Signature always fails.** You are verifying parsed-and-re-serialised JSON. Use the raw
body.

**Events stop arriving.** Check the webhook's `status` — repeated failures do not disable
it automatically, but someone may have. Also check whether events are `exhausted`.

**Duplicate processing.** You are not deduplicating on `svix-id`.

**Everything times out under load.** You are doing the work before responding.
