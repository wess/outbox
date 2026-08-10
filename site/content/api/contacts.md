---
title: Contacts
description: Create, update, and list contacts, with properties, segment membership, and topic subscriptions.
section: API reference
order: 14
---

# Contacts

A contact is a person you can send to, unique by email within a team.

## Create a contact

```
POST /contacts
```

| Field | Type | Notes |
|---|---|---|
| `email` | `string` | **Required.** Unique within the team |
| `first_name` | `string` | |
| `last_name` | `string` | |
| `unsubscribed` | `boolean` | Default `false` |
| `properties` | `object` | Keys must already exist as [contact properties](/api/contact-properties) |
| `segments` | `array` | `[{ id }]` — adds the contact to each |
| `topics` | `array` | `[{ id, subscription }]` |

```sh
curl -X POST https://outbox.example.com/contacts \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "steve@example.com",
    "first_name": "Steve",
    "last_name": "Wozniak",
    "properties": { "company_name": "Apple" },
    "segments": [{ "id": "78261eea-8f8b-4381-83c6-79fa7120f1cf" }],
    "topics": [{ "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e", "subscription": "opt_in" }]
  }'
```

```json
{ "object": "contact", "id": "e169aa45-1ecf-4183-9955-b1499d5701d3" }
```

An unknown property key is rejected rather than silently dropped:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "Unknown contact property `nope`. Create it first at /contact-properties."
}
```

## Retrieve a contact

```
GET /contacts/:id
```

`:id` accepts either the contact id or the email address:

```sh
curl https://outbox.example.com/contacts/steve@example.com \
  -H "Authorization: Bearer ob_xxxxxxxxx" -H "User-Agent: my-app/1.0"
```

```json
{
  "object": "contact",
  "id": "e169aa45-1ecf-4183-9955-b1499d5701d3",
  "email": "steve@example.com",
  "first_name": "Steve",
  "last_name": "Wozniak",
  "created_at": "2026-10-06 23:47:56.678+00",
  "unsubscribed": false,
  "properties": { "company_name": "Apple" }
}
```

Properties fall back to the property's `fallback_value` when the contact has no value of
its own, so templates always have something to render.

## Update a contact

```
PATCH /contacts/:id
```

Accepts `first_name`, `last_name`, `unsubscribed`, and `properties`. Only supplied
fields change.

```json
{ "unsubscribed": true }
```

Setting `unsubscribed` excludes the contact from every broadcast. It does not add them
to the [suppression list](/api/suppressions) — transactional mail still reaches them,
which is usually what you want for receipts and password resets.

## List contacts

```
GET /contacts
GET /contacts?segment_id=78261eea-8f8b-4381-83c6-79fa7120f1cf
```

Pagination is optional. `segment_id` narrows to one segment's membership.

## Delete a contact

```
DELETE /contacts/:id
```

Accepts an id or an email. Deleting a contact removes their segment memberships and
topic subscriptions. Emails already sent to them are unaffected.

## Topic subscriptions

```
GET /contacts/:id/topics
```

Returns every topic in the team with this contact's effective subscription, falling back
to the topic default where they have not chosen:

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e",
      "name": "Weekly Newsletter",
      "description": "Weekly digest",
      "subscription": "opt_in",
      "created_at": "2026-04-08 00:11:13.110779+00"
    }
  ]
}
```

```
PATCH /contacts/:id/topics
```

```json
{
  "topics": [
    { "id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e", "subscription": "opt_out" }
  ]
}
```

## Segment membership

```
GET    /contacts/:id/segments
POST   /contacts/:id/segments/:segment_id
DELETE /contacts/:id/segments/:segment_id
```

Adding a contact to a segment they are already in is a no-op, not an error.

## Audience-scoped routes

Before Segments, contacts hung off an audience. Those paths still work, so existing SDK
code that passes an `audience_id` keeps functioning:

```
POST   /audiences/:segment_id/contacts
GET    /audiences/:segment_id/contacts
GET    /audiences/:segment_id/contacts/:id
PATCH  /audiences/:segment_id/contacts/:id
DELETE /audiences/:segment_id/contacts/:id
```

They read and write the same contacts as `/contacts`. Creating through this path adds
the contact to the segment; if the contact already exists it is added rather than
rejected.

## Events

`contact.created`, `contact.updated`, and `contact.deleted` fire to subscribed
[webhooks](/api/webhooks).
