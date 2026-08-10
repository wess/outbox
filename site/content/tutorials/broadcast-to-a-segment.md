---
title: Broadcast to a segment
description: Build an audience, personalise a message, and send it to everyone who should get it.
section: Tutorials
order: 34
---

# Broadcast to a segment

A broadcast is one message to every contact in a segment, rendered per contact. This
walks through the whole path: properties, contacts, a topic, the send, and reading the
results.

## 1. Define properties

Declare the custom fields you want to personalise with, before importing:

```sh
curl -X POST https://outbox.example.com/contact-properties \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "key": "company_name", "type": "string", "fallback_value": "your team" }'
```

The fallback is what keeps `Hi {{{first_name}}} at {{{company_name}}}` from reading
badly for contacts with sparse data.

## 2. Create a segment

```sh
curl -X POST https://outbox.example.com/segments \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Product updates" }'
```

## 3. Add contacts

```ts
const contacts = [
  { email: "ada@example.com", first_name: "Ada", company: "Analytical Engines" },
  { email: "grace@example.com", first_name: "Grace", company: "Compiler Co" },
]

for (const person of contacts) {
  await fetch(`${BASE}/contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: person.email,
      first_name: person.first_name,
      properties: { company_name: person.company },
      segments: [{ id: SEGMENT_ID }],
    }),
  })
}
```

Import your suppression list **first** if you are moving from another provider. Mailing
addresses that already bounced is the fastest way to damage a new domain.

## 4. Create a topic

Marketing mail needs a way out that is not "unsubscribe from everything":

```sh
curl -X POST https://outbox.example.com/topics \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Product updates",
    "description": "New features and changes, about twice a month",
    "default_subscription": "opt_in"
  }'
```

Use `opt_out` as the default where consent is a legal question rather than a preference.

## 5. Write the broadcast

```sh
curl -X POST https://outbox.example.com/broadcasts \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "segment_id": "'"$SEGMENT_ID"'",
    "topic_id": "'"$TOPIC_ID"'",
    "from": "Acme <news@mail.acme.com>",
    "subject": "{{{first_name|Hey}}}, three things shipped this month",
    "preview_text": "Scheduled sends, better search, and a faster dashboard",
    "html": "<p>Hi {{{first_name|there}}},</p><p>Here is what we shipped for {{{company_name}}} this month.</p><ul><li>Scheduled sends</li><li>Better search</li></ul><p><a href=\"https://acme.com/changelog\">Read the changelog</a></p><p style=\"font-size:12px;color:#888\"><a href=\"{{{OUTBOX_UNSUBSCRIBE_URL}}}\">Unsubscribe from product updates</a></p>"
  }'
```

Without `send` or `scheduled_at` this saves a draft.

`preview_text` is the preheader — the grey line after the subject in most inboxes. Left
empty, clients show the first words of your HTML, which is often "View in browser".

## 6. Preview before sending

Send yourself a copy as a normal email using the same body, or open the broadcast in the
dashboard, which renders the published content. Check:

- Every `{{{variable}}}` has a fallback.
- The unsubscribe link is present and reachable.
- It reads sensibly with images blocked.

## 7. Send

```sh
curl -X POST https://outbox.example.com/broadcasts/$BROADCAST_ID/send \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

Or schedule it:

```json
{ "scheduled_at": "2026-08-12T14:00:00Z" }
```

Fan-out runs in the worker. Each eligible contact gets a real email row, so per-recipient
tracking works exactly as it does for transactional mail.

### Who is skipped

| Reason | Cause |
|---|---|
| `unsubscribed` | The contact's `unsubscribed` flag |
| `suppressed` | The address is on the suppression list |
| `opted out of topic` | They opted out of this broadcast's topic |

## 8. Read the results

```sh
curl https://outbox.example.com/broadcasts/$BROADCAST_ID/metrics \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{
  "total": 1284,
  "sent": 1201,
  "delivered": { "count": 1180, "percentage": 91.9 },
  "opened": { "count": 512, "percentage": 39.87 },
  "clicked": { "count": 98, "percentage": 7.63 },
  "bounced": { "count": 21, "percentage": 1.63 },
  "clicked_links": [
    { "url": "https://acme.com/changelog", "clicks": 74, "unique_clicks": 61 }
  ]
}
```

Drill into any group:

```sh
curl "https://outbox.example.com/broadcasts/$BROADCAST_ID/recipients?type=bounced" \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

### Reading the numbers honestly

**Bounce rate above 2%** means list quality problems. Hard bounces are suppressed
automatically, but a high rate on a first send says the list was stale before you
imported it.

**Complaint rate above 0.1%** is a warning. Above 0.3% and mailbox providers start
throttling you. Complaints usually mean people do not remember signing up.

**Open rate** is unreliable — Apple pre-fetches images and inflates it, image blocking
deflates it. Watch the trend, not the number.

**Click rate** is the number that means something.

## Sending to a subset

There is no query-based segmentation yet. Build the subset in your own system and
maintain a segment:

```ts
const active = await db.query("SELECT email FROM users WHERE last_seen > now() - interval '30 days'")

for (const user of active) {
  await fetch(`${BASE}/contacts/${user.email}/segments/${ACTIVE_SEGMENT_ID}`, {
    method: "POST",
    headers,
  })
}
```

Adding a contact already in the segment is a no-op, so this is safe to run on a schedule.
