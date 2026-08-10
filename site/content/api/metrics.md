---
title: Metrics
description: Aggregate email and segment metrics with configurable granularity and dimensions.
section: API reference
order: 23
---

# Metrics

## Email metrics

```
GET /emails/metrics
```

Aggregates over `email_events`, so it reflects the same data the dashboard charts.

### Parameters

| Parameter | Notes |
|---|---|
| `start_date` | ISO 8601. Defaults to 30 days ago |
| `end_date` | ISO 8601. Defaults to now |
| `granularity` | `hourly`, `daily` (default), `weekly`, `monthly` |
| `timezone` | IANA name for bucket boundaries. Default `UTC` |
| `metrics` | Comma-separated. See below |
| `dimensions` | Comma-separated: `period`, `domain`, `email` |
| `domain_id` | Comma-separated filter |
| `email_id` | Comma-separated filter |
| `sort_by` | A metric or dimension name |
| `sort_order` | `asc` or `desc` |

### Available metrics

Counts: `sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`,
`delivery_delayed`, `failed`, `canceled`, `suppressed`.

Rates, returned as percentages: `delivery_rate`, `open_rate`, `click_rate`,
`bounce_rate`, `complaint_rate`.

| Rate | Computed as |
|---|---|
| `delivery_rate` | delivered ÷ sent |
| `open_rate` | opened ÷ delivered |
| `click_rate` | clicked ÷ delivered |
| `bounce_rate` | bounced ÷ sent |
| `complaint_rate` | complained ÷ delivered |

Open and click rates use *delivered* as the denominator, not sent — a message that never
arrived cannot be opened, and dividing by sent understates engagement.

### Example

```sh
curl "https://outbox.example.com/emails/metrics?start_date=2026-07-01&end_date=2026-07-08&granularity=daily&dimensions=period&metrics=sent,delivered,open_rate" \
  -H "Authorization: Bearer ob_xxxxxxxxx" -H "User-Agent: my-app/1.0"
```

```json
{
  "object": "list",
  "data": [
    { "period": "2026-07-01T00:00:00.000Z", "sent": 1204, "delivered": 1180, "open_rate": 43.39 },
    { "period": "2026-07-02T00:00:00.000Z", "sent": 998, "delivered": 981, "open_rate": 41.08 }
  ],
  "start_date": "2026-07-01T00:00:00.000Z",
  "end_date": "2026-07-08T00:00:00.000Z",
  "granularity": "daily"
}
```

Without `dimensions` you get a single bucket covering the whole range — useful for a
headline number.

Combine dimensions to slice:

```
?dimensions=period,domain&metrics=sent,bounce_rate
```

### Counting

Counts are **distinct emails**, not raw events. One recipient opening the same message
five times counts once toward `opened`. Per-recipient counts live in
[broadcast recipients](/api/broadcasts#list-recipients).

### On open tracking

Open rates are directionally useful and precisely wrong. Apple Mail Privacy Protection
pre-fetches images, inflating opens; clients that block images suppress them entirely.
Outbox drops obvious bot and proxy user-agents, which helps but does not fix it.

Trust clicks. Watch opens as a trend, not a number.

## Segment metrics

```
GET /segments/metrics
```

| Parameter | Notes |
|---|---|
| `segment_id` | Comma-separated filter |
| `sort_by`, `sort_order` | |

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

## Dashboard summary

```
GET /dashboard/summary
```

Session-authenticated rather than key-authenticated — it backs the dashboard's own
counters. Returns totals for emails, contacts, domains, broadcasts, templates, segments,
suppressions, webhooks, automations, API keys, and pending jobs.

`queued_jobs` is the one to watch operationally. If it climbs and does not fall, no
worker is running.
