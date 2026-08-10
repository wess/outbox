---
title: Segments
description: Group contacts for broadcasts. Includes the legacy audiences alias.
section: API reference
order: 15
---

# Segments

A segment is a named group of contacts. Broadcasts target a segment.

> Segments were previously called audiences. Every endpoint below is mounted at both
> `/segments` and `/audiences`, so older SDK code keeps working.

## Create a segment

```
POST /segments
```

```json
{ "name": "Registered Users" }
```

```json
{
  "object": "segment",
  "id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
  "name": "Registered Users"
}
```

## Retrieve a segment

```
GET /segments/:segment_id
```

```json
{
  "object": "segment",
  "id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
  "name": "Registered Users",
  "created_at": "2026-10-06 22:59:55.977+00"
}
```

## List segments

```
GET /segments
```

Pagination is optional.

## List a segment's contacts

```
GET /segments/:segment_id/contacts
```

Returns full contact objects, paginated.

## Delete a segment

```
DELETE /segments/:segment_id
```

Deleting a segment removes the grouping, not the contacts. Broadcasts that referenced it
keep their history; their `segment_id` becomes `null`.

## Adding and removing contacts

Membership is managed from the contact side:

```
POST   /contacts/:id/segments/:segment_id
DELETE /contacts/:id/segments/:segment_id
```

Or at creation time:

```json
{
  "email": "steve@example.com",
  "segments": [{ "id": "78261eea-8f8b-4381-83c6-79fa7120f1cf" }]
}
```

## Metrics

```
GET /segments/metrics
```

Optionally filtered with `segment_id` (comma-separated).

```json
{
  "object": "list",
  "data": [
    {
      "segment_id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
      "name": "Registered Users",
      "all_contacts": 1284,
      "subscribed_contacts": 1201,
      "unsubscribed_contacts": 83
    }
  ]
}
```

`subscribed_contacts` is what a broadcast to this segment will actually attempt, before
suppression and topic checks narrow it further.
