---
title: Broadcasts
description: Send one personalised message to every contact in a segment, with per-broadcast metrics.
section: API reference
order: 18
---

# Broadcasts

A broadcast is one message sent to every contact in a segment. Fan-out happens in the
worker: each eligible contact gets a real email row rendered with their own values, so
tracking, events, and metrics work exactly as they do for transactional mail.

## Create a broadcast

```
POST /broadcasts
```

| Field | Type | Notes |
|---|---|---|
| `segment_id` | `string` | **Required.** `audience_id` is accepted as an alias |
| `from` | `string` | **Required** |
| `subject` | `string` | **Required.** Supports variables |
| `html` | `string` | One of `html` or `text` is required |
| `text` | `string` | |
| `preview_text` | `string` | Preheader shown in the inbox list |
| `reply_to` | `string \| string[]` | |
| `name` | `string` | Internal label. Defaults to the subject |
| `topic_id` | `string` | Gates each recipient on subscription |
| `send` | `boolean` | Send immediately instead of saving a draft |
| `scheduled_at` | `string` | ISO 8601 or natural language |

```sh
curl -X POST https://outbox.example.com/broadcasts \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "segment_id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
    "from": "Acme <news@acme.com>",
    "subject": "Hello {{{contact.first_name|there}}}",
    "html": "<p>Hi {{{contact.first_name|there}}}, here is this week.</p><p><a href=\"{{{OUTBOX_UNSUBSCRIBE_URL}}}\">Unsubscribe</a></p>",
    "preview_text": "This week at Acme"
  }'
```

```json
{ "object": "broadcast", "id": "559ac32e-9ef5-46fb-82a1-b76b840c0f7b" }
```

Without `send` or `scheduled_at` the broadcast is saved as a draft.

## Personalisation

Subject and body are rendered per contact:

```html
<p>Hi {{{contact.first_name|there}}}, {{{company_name}}} renews on {{{renewal_date}}}.</p>
```

Available: `contact.email`, `contact.first_name`, `contact.last_name`, and every
[contact property](/api/contact-properties) by name. Always give an inline fallback for
anything that might be missing.

## Send a broadcast

```
POST /broadcasts/:broadcast_id/send
```

```json
{ "scheduled_at": "in 2 hours" }
```

Omit the body to send now. Status moves `draft` → `sending` → `sent`, or `scheduled`
first if a time was given.

### Who gets skipped

Fan-out records a reason for every contact it skips:

| Reason | Cause |
|---|---|
| `unsubscribed` | The contact's `unsubscribed` flag |
| `suppressed` | The address is on the suppression list |
| `opted out of topic` | The broadcast has a `topic_id` they opted out of |

## Retrieve a broadcast

```
GET /broadcasts/:broadcast_id
```

```json
{
  "object": "broadcast",
  "id": "559ac32e-9ef5-46fb-82a1-b76b840c0f7b",
  "name": "Announcements",
  "audience_id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
  "segment_id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
  "from": "Acme <news@acme.com>",
  "subject": "Hello {{{contact.first_name|there}}}",
  "reply_to": null,
  "preview_text": "This week at Acme",
  "html": "<p>…</p>",
  "text": null,
  "status": "sent",
  "created_at": "2026-12-01 19:32:22.980+00",
  "scheduled_at": null,
  "sent_at": "2026-12-01 19:33:02.114+00",
  "topic_id": null
}
```

`audience_id` is returned alongside `segment_id` with the same value, so older SDKs keep
working.

## List broadcasts

```
GET /broadcasts
```

Pagination is optional. List items are trimmed to ids, status, and timestamps.

## Update a broadcast

```
PATCH /broadcasts/:broadcast_id
```

Accepts the same content fields as create. A broadcast that is `sending` or `sent` can
no longer be edited:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "A broadcast that is sending or sent can no longer be edited."
}
```

## Delete a broadcast

```
DELETE /broadcasts/:broadcast_id
```

Allowed for drafts, scheduled, and sent broadcasts. A broadcast currently `sending`
cannot be deleted.

## Metrics

```
GET /broadcasts/:broadcast_id/metrics
```

```json
{
  "object": "broadcast_metrics",
  "broadcast_id": "559ac32e-9ef5-46fb-82a1-b76b840c0f7b",
  "status": "sent",
  "total": 1284,
  "sent": 1201,
  "remaining": 0,
  "delivered": { "count": 1180, "percentage": 91.9 },
  "opened": { "count": 512, "percentage": 39.87 },
  "clicked": { "count": 98, "percentage": 7.63 },
  "unsubscribed": { "count": 4, "percentage": 0.31 },
  "bounced": { "count": 21, "percentage": 1.63 },
  "complained": { "count": 1, "percentage": 0.07 },
  "suppressed": { "count": 0, "percentage": 0 },
  "clicked_links": [
    { "url": "https://acme.com/pricing", "clicks": 74, "unique_clicks": 61 }
  ]
}
```

`total` counts every contact considered, including skipped ones; `sent` counts those
actually queued. Percentages are against `total`.

`clicked_links` requires click tracking on the sending domain.

## List recipients

```
GET /broadcasts/:broadcast_id/recipients?type=clicked
```

| Parameter | Notes |
|---|---|
| `type` | **Required.** `sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, `unsubscribed`, `suppressed` |
| `limit` | Up to 100 |
| `email` | Filter to one address |
| `bounce_type` | Filter bounces by `hard` or `soft` |

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "id": "8b9a1f2c-...",
      "contact_id": "e169aa45-...",
      "email": "reader@example.com",
      "count": 3,
      "bounce_type": null
    }
  ]
}
```

`count` is how many times that recipient produced the event — useful for spotting the
difference between one enthusiastic reader and broad engagement.
