---
title: Emails
description: Send, retrieve, schedule, cancel, and list emails, plus attachments and inbound mail.
section: API reference
order: 11
---

# Emails

## Send an email

```
POST /emails
```

### Body

| Field | Type | Notes |
|---|---|---|
| `from` | `string` | **Required.** `email@example.com` or `Name <email@example.com>` |
| `to` | `string \| string[]` | **Required.** Max 50 recipients across to, cc, and bcc |
| `subject` | `string` | **Required** unless supplied by a template |
| `html` | `string` | One of `html`, `text`, or `template` is required |
| `text` | `string` | Derived from `html` when omitted |
| `cc` | `string \| string[]` | |
| `bcc` | `string \| string[]` | |
| `reply_to` | `string \| string[]` | |
| `headers` | `object` | Custom headers. Identity and routing headers are ignored |
| `tags` | `array` | `{ name, value }`, alphanumeric plus `_` and `-` |
| `topic_id` | `string` | Gates delivery on subscription |
| `scheduled_at` | `string` | ISO 8601 or natural language |
| `attachments` | `array` | See [Attachments](#attachments) |
| `template` | `object` | `{ id, variables }` — id or alias |

```sh
curl -X POST https://outbox.example.com/emails \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <onboarding@acme.com>",
    "to": ["user@example.com"],
    "subject": "Hello World",
    "html": "<strong>It works!</strong>",
    "tags": [{ "name": "category", "value": "confirm_email" }]
  }'
```

```json
{ "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }
```

The response returns as soon as the email is validated and queued. Delivery happens in
the worker — poll the email or subscribe to [webhooks](/api/webhooks) for its outcome.

### Sending domains

`from` must use a domain you have added and verified. An unverified domain returns:

```json
{
  "statusCode": 403,
  "name": "invalid_from_address",
  "message": "The acme.com domain is not verified. Add and verify it at /domains."
}
```

With `OUTBOX_TRANSPORT=console` this check is skipped, so you can develop before owning
a domain.

## Send a batch

```
POST /emails/batch
```

Takes an array of up to 100 send payloads and returns their ids in order. Attachments
are not supported in batch sends.

```sh
curl -X POST https://outbox.example.com/emails/batch \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '[
    { "from": "Acme <a@acme.com>", "to": ["one@example.com"], "subject": "One", "text": "1" },
    { "from": "Acme <a@acme.com>", "to": ["two@example.com"], "subject": "Two", "text": "2" }
  ]'
```

```json
{
  "data": [
    { "id": "ae2014de-c168-4c61-8267-70d2662a1ce1" },
    { "id": "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb" }
  ]
}
```

## Retrieve an email

```
GET /emails/:id
```

```json
{
  "object": "email",
  "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  "message_id": "<111-222-333@acme.com>",
  "to": ["user@example.com"],
  "from": "Acme <onboarding@acme.com>",
  "created_at": "2026-04-03 22:13:42.674981+00",
  "subject": "Hello World",
  "html": "<strong>It works!</strong>",
  "text": null,
  "bcc": [],
  "cc": [],
  "reply_to": [],
  "last_event": "delivered",
  "scheduled_at": null,
  "tags": [{ "name": "category", "value": "confirm_email" }]
}
```

### last_event

| Value | Meaning |
|---|---|
| `queued` | Accepted, waiting for a worker |
| `scheduled` | Waiting for its send time |
| `sent` | Handed to the transport |
| `delivered` | Accepted by the receiving server |
| `delivery_delayed` | Temporary failure, will retry |
| `opened` | Tracking pixel loaded |
| `clicked` | A tracked link was followed |
| `bounced` | Permanent failure |
| `complained` | Marked as spam |
| `failed` | Could not be sent |
| `canceled` | A scheduled send was cancelled |
| `suppressed` | Recipient is on the suppression list |

Terminal states never regress — an open arriving after a bounce leaves the bounce in
place.

`bounced`, `complained`, and `delivery_delayed` are usually set *after* delivery, from
a report that arrives at the return path minutes or days later. See [Handle
bounces](/tutorials/handle-bounces).

## List emails

```
GET /emails
```

Always paginated. Accepts `limit`, `after`, `before`. `cc`, `bcc`, and `reply_to` come
back as `null` rather than `[]` in list items, matching Resend.

## Schedule

Pass `scheduled_at` as ISO 8601 or natural language:

```json
{ "scheduled_at": "in 1 hour" }
```

Understood forms: `in 30 seconds`, `in 5 minutes`, `in 2 hours`, `in 3 days`,
`in 1 week`, `tomorrow`, `now`, and any ISO 8601 timestamp. A time in the past sends
immediately rather than erroring, which absorbs clock skew between client and server.

### Reschedule

```
PATCH /emails/:id
```

```json
{ "scheduled_at": "2026-08-05T11:52:01.858Z" }
```

Only emails in `scheduled` state can be rescheduled.

### Cancel

```
POST /emails/:id/cancel
```

Only emails in `scheduled` state can be cancelled.

## Idempotency

Pass an `Idempotency-Key` header to make a send safe to retry:

```sh
curl -X POST https://outbox.example.com/emails \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Idempotency-Key: order-1234-confirmation" \
  -H "Content-Type: application/json" \
  -d '{ "from": "...", "to": ["..."], "subject": "...", "html": "..." }'
```

| Situation | Result |
|---|---|
| Same key, same body | Replays the stored response. Nothing is sent again |
| Same key, different body | `400 invalid_idempotent_request` |
| Same key while the first is in flight | `409 concurrent_idempotent_requests` |
| A failed request | The key is released so a retry can succeed |

Keys live 24 hours. Use something derived from the thing you are emailing about — an
order id, not a random UUID.

## Attachments

Up to 40MB per email after Base64 encoding, configurable with `MAX_ATTACHMENT_BYTES`.

```json
{
  "attachments": [
    { "filename": "invoice.pdf", "content": "JVBERi0xLjQK..." },
    { "filename": "logo.png", "path": "https://acme.com/logo.png", "content_id": "logo" }
  ]
}
```

| Field | Notes |
|---|---|
| `filename` | Required unless `path` is given |
| `content` | Base64 string or byte array |
| `path` | URL to fetch instead of inline content |
| `content_type` | Guessed from the extension when omitted |
| `content_id` | Makes it inline — reference as `cid:logo` in HTML |

Executable extensions (`.exe`, `.bat`, `.js`, `.jar` and similar) are rejected with
`422 invalid_attachment`, since receiving servers strip them anyway.

### List and retrieve

```
GET /emails/:email_id/attachments
GET /emails/:email_id/attachments/:id
```

The single-attachment response includes the Base64 `content`.

## Received emails

Available when [receiving](/tutorials/receive-inbound-email) is enabled.

```
GET /emails/receiving
GET /emails/receiving/:id
GET /emails/receiving/:email_id/attachments
GET /emails/receiving/:email_id/attachments/:id
```

```json
{
  "object": "received_email",
  "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  "message_id": "<abc@sender.com>",
  "from": "Sender <sender@example.com>",
  "to": ["support@acme.com"],
  "cc": [],
  "received_for": ["support@acme.com"],
  "subject": "Help please",
  "html": "<p>My widget is broken.</p>",
  "text": "My widget is broken.",
  "headers": { "message-id": "<abc@sender.com>" },
  "spf": null,
  "dkim": null,
  "dmarc": null,
  "created_at": "2026-04-03 22:13:42.674981+00"
}
```

## Metrics

See [Metrics](/api/metrics) for `GET /emails/metrics`.
