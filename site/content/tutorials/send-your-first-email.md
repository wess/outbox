---
title: Send your first email
description: From a running instance to a delivered message, with the state machine explained.
section: Tutorials
order: 30
---

# Send your first email

Assumes you have Outbox running from the [quickstart](/quickstart) and an API key.

## 1. Send it

```sh
curl -X POST http://localhost:3000/emails \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <onboarding@example.com>",
    "to": ["you@example.com"],
    "subject": "Hello from Outbox",
    "html": "<h1>It works</h1><p>Sent from my own server.</p>"
  }'
```

```json
{ "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }
```

That id is the handle for everything that follows.

## 2. Watch it move

```sh
curl http://localhost:3000/emails/4ef9a417-02e9-4d39-ad75-9611e0fcc33c \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

`last_event` walks through the lifecycle:

```
queued      accepted, waiting for a worker
sent        handed to the transport
delivered   accepted by the receiving server
opened      the tracking pixel loaded
clicked     a tracked link was followed
```

On the `console` transport the whole body is printed to the worker log, and the email is
marked delivered immediately. That is the point of it — you can build the entire flow
before you own a domain.

If it stays `queued` forever, no worker is running. `bun run dev` starts one; `bun run
api` alone does not.

## 3. Add the things that matter

### Plain text

Always include a text part. Outbox derives one from your HTML when you omit it, but a
hand-written version reads better and some filters weight its absence.

```json
{
  "html": "<h1>It works</h1>",
  "text": "It works"
}
```

### Reply-to

```json
{
  "from": "Acme <noreply@acme.com>",
  "reply_to": "support@acme.com"
}
```

Sending from `noreply@` and offering nowhere to reply is a choice customers notice.

### Tags

```json
{
  "tags": [
    { "name": "category", "value": "welcome" },
    { "name": "user_id", "value": "1234" }
  ]
}
```

Tags come back on the email and in webhook payloads, so you can attribute events to your
own concepts. Names and values allow letters, numbers, `_`, and `-`.

### Multiple recipients

```json
{ "to": ["a@example.com", "b@example.com"], "cc": ["c@example.com"] }
```

Everyone in `to` sees everyone else. For a mailing list you want either
[batch send](/api/emails#send-a-batch) or a [broadcast](/tutorials/broadcast-to-a-segment)
— not fifty addresses in one `to`.

Maximum 50 across to, cc, and bcc.

### Attachments

```json
{
  "attachments": [
    { "filename": "receipt.pdf", "content": "JVBERi0xLjQK..." }
  ]
}
```

Base64 in `content`, or a URL in `path` for Outbox to fetch. Up to 40MB.

### Scheduling

```json
{ "scheduled_at": "in 1 hour" }
```

Or ISO 8601. Scheduled emails can be [rescheduled or
cancelled](/api/emails#reschedule) until they send.

## 4. Make retries safe

Any network call can time out after the server accepted it. Without protection, your
retry sends a second copy.

```sh
curl -X POST http://localhost:3000/emails \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Idempotency-Key: order-1234-confirmation" \
  -H "Content-Type: application/json" \
  -d '{ … }'
```

Repeating that request with the same key replays the original response. Derive the key
from the thing you are emailing about — an order id, an invoice number — not a random
UUID, which defeats the purpose.

## 5. From an application

```ts
import { Resend } from "resend"

const resend = new Resend(process.env.OUTBOX_API_KEY, {
  baseUrl: process.env.OUTBOX_URL,
})

export const sendWelcome = async (user: { email: string; name: string }) => {
  const { data, error } = await resend.emails.send({
    from: "Acme <onboarding@acme.com>",
    to: [user.email],
    subject: `Welcome, ${user.name}`,
    html: `<h1>Welcome</h1><p>Glad you're here, ${user.name}.</p>`,
    tags: [{ name: "category", value: "welcome" }],
  })

  if (error) {
    // Log it and move on — a failed welcome email should not fail a signup.
    console.error("welcome email failed", error)
    return null
  }
  return data.id
}
```

Two habits worth forming now:

**Never block the user on an email.** Sending is fast but not instant, and a mail problem
should not become a signup problem.

**Log the id.** When someone asks whether the email went out, `last_event` answers it in
one request — but only if you kept the id.

## Next

- [Verify a domain](/tutorials/verify-a-domain) — required before real delivery.
- [Transactional email with templates](/tutorials/transactional-with-templates) — get content out of your code.
- [Handle webhooks](/tutorials/handle-webhooks) — react to bounces and opens.
