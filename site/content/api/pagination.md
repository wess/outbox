---
title: Pagination
description: Cursor pagination, the list envelope, and how to walk a full result set.
section: API reference
order: 25
---

# Pagination

List endpoints return a consistent envelope and page with cursors rather than offsets, so
results stay stable while records are being created and deleted underneath you.

## The envelope

```json
{
  "object": "list",
  "has_more": true,
  "data": [ /* … */ ]
}
```

| Field | Meaning |
|---|---|
| `object` | Always `list` |
| `has_more` | Whether more items exist beyond this page |
| `data` | The items |

## Parameters

| Parameter | Notes |
|---|---|
| `limit` | 1–100. Default 20 |
| `after` | Cursor. Returns the page **starting after** this id |
| `before` | Cursor. Returns the page **ending before** this id |

Cursors are resource ids and are **exclusive** — the item you name is never in the
result. Passing both `after` and `before` is an error:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "You can only use either `after` or `before`, not both simultaneously."
}
```

An id that does not exist is also an error, rather than silently returning page one:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "The provided pagination cursor does not exist."
}
```

## Always vs optionally paginated

Endpoints added later always paginate. Older ones return everything when you omit
`limit`, matching Resend's behaviour.

| Always paginated | Optional |
|---|---|
| `/emails`, `/templates`, `/topics`, `/suppressions`, `/logs`, `/automations`, `/webhooks/:id/events` | `/domains`, `/api-keys`, `/broadcasts`, `/segments`, `/contacts`, `/contact-properties`, `/webhooks`, `/emails/receiving` |

Relying on the unbounded form is fine for a few hundred rows and a bad idea for a
hundred thousand. Pass `limit` and page.

## Walking forward

```ts
const all = []
let after: string | undefined

for (;;) {
  const url = new URL("https://outbox.example.com/emails")
  url.searchParams.set("limit", "100")
  if (after) url.searchParams.set("after", after)

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, "user-agent": "my-app/1.0" },
  })
  const page = await res.json()

  all.push(...page.data)
  if (!page.has_more) break
  after = page.data[page.data.length - 1].id
}
```

The cursor is the id of the **last** item on the page you just received.

## Walking backward

`before` takes the id of the **first** item on your current page and returns the page
before it:

```ts
const previous = await fetch(
  `https://outbox.example.com/emails?limit=25&before=${page.data[0].id}`,
  { headers: { authorization: `Bearer ${key}`, "user-agent": "my-app/1.0" } },
)
```

## Ordering

Lists are newest first, ordered by `(created_at, id)`. The compound key matters: rows
created in the same millisecond still have a deterministic order, so paging never skips
or repeats an item.

The comparison happens inside the database rather than by round-tripping a timestamp
through the client, because Postgres stores microseconds and most languages' date types
do not — truncating would leave the cursor row inside its own range.

## Filters

Some endpoints add filters that combine with pagination:

| Endpoint | Filter |
|---|---|
| `/contacts` | `segment_id` |
| `/suppressions` | `origin` |
| `/broadcasts/:id/recipients` | `type` (required), `email`, `bounce_type` |
| `/emails/metrics` | `domain_id`, `email_id` |

## Rate limits while paging

Paging a large set can outrun the 10 requests per second limit. Handle 429 by honouring
`retry-after`:

```ts
if (res.status === 429) {
  await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 1) * 1000))
  continue
}
```

Larger pages beat faster requests — `limit=100` costs the same one request as `limit=20`.
