---
title: Logs
description: Every API request, with its body and response, for debugging integrations.
section: API reference
order: 24
---

# Logs

Outbox records every API request your team makes — method, path, status, user agent, IP,
duration, and both bodies. When an integration misbehaves this is usually the fastest way
to find out what was actually sent, rather than what you believe was sent.

## List logs

```
GET /logs
```

Always paginated. Newest first.

```json
{
  "object": "list",
  "has_more": true,
  "data": [
    {
      "object": "log",
      "id": "37e4414c-5e25-4dbc-a071-43552a4bd53b",
      "created_at": "2026-03-30 13:43:54.622865+00",
      "endpoint": "/emails",
      "method": "POST",
      "response_status": 200,
      "user_agent": "resend-node:6.18.1"
    }
  ]
}
```

## Retrieve a log

```
GET /logs/:log_id
```

Adds the request and response bodies:

```json
{
  "object": "log",
  "id": "37e4414c-5e25-4dbc-a071-43552a4bd53b",
  "created_at": "2026-03-30 13:43:54.622865+00",
  "endpoint": "/emails",
  "method": "POST",
  "response_status": 422,
  "user_agent": "resend-node:6.18.1",
  "request_body": {
    "from": "Acme <onboarding@acme.com>",
    "to": ["user@example.com"]
  },
  "response_body": {
    "statusCode": 422,
    "name": "missing_required_field",
    "message": "Missing `subject` field."
  }
}
```

## What gets logged

Every authenticated API request, plus unauthenticated attempts against API paths, which
is how you spot a deploy still carrying a deleted key.

Not logged: the dashboard's own calls, tracking pixel and click redirects, unsubscribe
pages, and `/health`. Those would drown the useful entries.

## Privacy

Request bodies are stored verbatim, which means **message content, recipient addresses,
and Base64 attachments are in this table**. That is what makes it useful for debugging
and what makes it sensitive.

Two consequences worth acting on:

1. It grows quickly when you send attachments. Prune it.
2. It is a copy of your customers' mail. Treat access to it, and to database backups,
   accordingly.

API keys are never logged — authorization headers are not recorded at all.

## Retention

Nothing prunes automatically; retention is your policy. A reasonable default:

```sql
DELETE FROM api_logs WHERE created_at < now() - interval '30 days';
```

Run it from cron. If you send large attachments, consider seven days, or strip bodies
older than a few days while keeping the metadata:

```sql
UPDATE api_logs
SET request_body = NULL, response_body = NULL
WHERE created_at < now() - interval '7 days'
  AND request_body IS NOT NULL;
```

## Debugging with logs

A few patterns that come up:

**"The email never arrived."** Find the request, confirm it returned 200 and an id, then
look at the email's `last_event`. A 200 means Outbox accepted it — delivery is a separate
question answered by events and webhooks.

**"We're getting 422s."** The response body names the exact field. Compare
`request_body` against what your code believes it sends; the difference is usually a
camelCase key that never got converted.

**"Something is still using the old key."** Filter by user agent and watch for 403s after
you delete a key.
