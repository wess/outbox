---
title: Receive inbound email
description: Accept mail on your own domain, parse it, and act on it in your application.
section: Tutorials
order: 37
---

# Receive inbound email

Outbox includes an SMTP server. Point a domain's MX record at it and mail addressed to
that domain is parsed, stored with attachments, and raised as `email.received`.

Useful for support inboxes, reply-to-comment threads, `+` addressing per customer, and
giving an agent a real mailbox.

## 1. Enable the listener

```sh
INBOUND_ENABLED=true
INBOUND_PORT=2525
OUTBOX_HOSTNAME=mail.acme.com
```

```sh
bun run inbound      # or `bun run dev`, which starts it when enabled
```

Port 2525 keeps the process off a privileged port. Forward 25 to it:

```sh
# Linux
iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
```

Or terminate 25 at your load balancer and forward.

## 2. Enable receiving on the domain

```sh
curl -X PATCH https://outbox.example.com/domains/$DOMAIN_ID \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "capabilities": { "sending": "enabled", "receiving": "enabled" } }'
```

This adds an MX record to the domain's record set.

## 3. Publish the MX record

| Type | Host | Value | Priority |
|---|---|---|---|
| MX | `mail.acme.com` | `inbound.mail.acme.com` | 10 |

> If the domain already receives mail — a Google Workspace domain, for instance — do
> **not** point its MX at Outbox. Use a dedicated subdomain such as `inbound.acme.com`.
> Replacing a live MX record silently stops delivery of everyone's mail.

Verify:

```sh
dig +short MX mail.acme.com
```

## 4. Test it

Send a message to any address on the domain:

```sh
echo "Testing inbound" | mail -s "Hello" support@mail.acme.com
```

Then:

```sh
curl https://outbox.example.com/emails/receiving \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "object": "received_email",
      "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      "from": "Someone <someone@gmail.com>",
      "to": ["support@mail.acme.com"],
      "subject": "Hello",
      "created_at": "2026-08-10 14:22:01.114+00"
    }
  ]
}
```

Only addresses on a domain with receiving enabled are accepted. Everything else gets
`550 5.1.1 No such recipient here` at RCPT TO, so you are not an open relay.

## 5. React to it

Subscribe to `email.received`:

```sh
curl -X POST https://outbox.example.com/webhooks \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "endpoint": "https://acme.com/webhooks/inbound", "events": ["email.received"] }'
```

```ts
const handle = async (event: { type: string; data: any }) => {
  if (event.type !== "email.received") return

  const mail = await outbox.emails.received.get(event.data.email_id)

  await db.tickets.create({
    from: mail.data.from,
    subject: mail.data.subject,
    body: mail.data.text ?? mail.data.html,
    messageId: mail.data.message_id,
  })
}
```

The webhook carries a summary; fetch the full record for bodies and headers.

## Routing with plus addressing

`support+ticket-1234@mail.acme.com` arrives with the full address in `received_for`, so
you can route without a separate mailbox per thread:

```ts
const [address] = mail.data.received_for
const match = address.match(/\+([^@]+)@/)
const ticketId = match?.[1]
```

Reply with that address in `reply_to` and the thread routes itself.

## Threading

Preserve the headers so mail clients thread correctly:

```ts
await outbox.emails.send({
  from: "Support <support@mail.acme.com>",
  to: [mail.data.from],
  subject: mail.data.subject.startsWith("Re:") ? mail.data.subject : `Re: ${mail.data.subject}`,
  html: "<p>Thanks — we're looking into it.</p>",
  headers: {
    "In-Reply-To": mail.data.message_id,
    References: mail.data.message_id,
  },
})
```

Without `In-Reply-To` and `References` your reply starts a new thread, which reads as a
different conversation to the recipient.

## Attachments

```sh
curl https://outbox.example.com/emails/receiving/$ID/attachments \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

Fetch one to get Base64 `content`. The parser handles multipart, quoted-printable,
Base64, and RFC 2047 encoded headers, and keeps inline images with their `content_id`.

**Treat every attachment as hostile.** It arrived from the internet. Scan it, do not
execute it, and do not serve it back from your own domain without setting
`Content-Disposition: attachment`.

## Operational notes

**Messages are capped at 30MB.** Larger ones get `552`.

**Nothing is authenticated yet.** SPF, DKIM, and DMARC results are stored as `null` —
Outbox accepts and records rather than validating inbound. Do not treat the `From` header
as proof of identity for anything that matters.

**Everything is stored.** Raw message and attachments live in Postgres. Plan retention:

```sql
DELETE FROM received_emails WHERE created_at < now() - interval '90 days';
```

**Port 25 is often blocked.** Many providers block inbound 25 by default. Check before
building on it.
