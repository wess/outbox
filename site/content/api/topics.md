---
title: Topics
description: Subscription categories that let recipients opt out of one kind of mail without opting out of everything.
section: API reference
order: 16
---

# Topics

A topic is a subscription category — "Weekly newsletter", "Product updates", "Billing
alerts". Without topics, unsubscribing is all-or-nothing; with them a recipient can drop
the newsletter and keep the security notices.

## Create a topic

```
POST /topics
```

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | **Required** |
| `default_subscription` | `string` | **Required.** `opt_in` or `opt_out` |
| `description` | `string` | Shown on the unsubscribe page |
| `visibility` | `string` | `public` (default) or `private` |

```sh
curl -X POST https://outbox.example.com/topics \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Weekly Newsletter",
    "description": "A digest every Thursday",
    "default_subscription": "opt_in"
  }'
```

```json
{ "object": "topic", "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e" }
```

### Choosing a default

`default_subscription` decides what happens for someone who has never expressed a
preference — including people who are not contacts at all.

| Default | Behaviour | Suits |
|---|---|---|
| `opt_in` | Send unless they opted out | Product updates, transactional-adjacent mail |
| `opt_out` | Do not send unless they opted in | Marketing, anything where consent matters |

Pick `opt_out` when consent is a legal question rather than a preference.

## Retrieve a topic

```
GET /topics/:topic_id
```

```json
{
  "object": "topic",
  "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e",
  "name": "Weekly Newsletter",
  "description": "A digest every Thursday",
  "default_subscription": "opt_in",
  "visibility": "public",
  "created_at": "2026-04-08 00:11:13.110779+00"
}
```

## List topics

```
GET /topics
```

Always paginated.

## Update a topic

```
PATCH /topics/:topic_id
```

Accepts `name`, `description`, and `visibility`. `default_subscription` is deliberately
immutable — changing it would silently alter the consent status of everyone who never
chose.

## Delete a topic

```
DELETE /topics/:topic_id
```

Deletes the topic and every subscription to it. Emails sent with that `topic_id` keep
their history.

## Sending with a topic

Pass `topic_id` on a send or a broadcast and each recipient is checked independently:

```json
{
  "from": "Acme <news@acme.com>",
  "to": ["reader@example.com"],
  "subject": "This week at Acme",
  "html": "<p>…</p>",
  "topic_id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e"
}
```

| Recipient | Outcome |
|---|---|
| Contact, opted in | Sent |
| Contact, opted out | Skipped, `email.failed` with a reason |
| Not a contact | Follows `default_subscription` |

Each of `to`, `cc`, and `bcc` is evaluated separately, so one opted-out recipient does
not block the rest.

## Managing subscriptions

Per contact:

```
GET   /contacts/:id/topics
PATCH /contacts/:id/topics
```

```json
{
  "topics": [
    { "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e", "subscription": "opt_out" }
  ]
}
```

## Unsubscribe links

Put the placeholder in your body and Outbox replaces it per recipient with a signed URL:

```html
<a href="{{{OUTBOX_UNSUBSCRIBE_URL}}}">Unsubscribe</a>
```

`{{{RESEND_UNSUBSCRIBE_URL}}}` is accepted too, so templates carried over from Resend
work unchanged.

When the email carries a `topic_id` the link opts the recipient out of that topic only.
Without one it unsubscribes them entirely. Outbox also sets `List-Unsubscribe` and
`List-Unsubscribe-Post`, so mail clients can offer one-click unsubscribe — which
materially helps deliverability at Gmail and Outlook.
