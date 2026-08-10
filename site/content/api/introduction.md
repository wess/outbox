---
title: Introduction
description: Base URL, authentication, required headers, response codes, and rate limits.
section: API reference
order: 10
---

# API reference

The Outbox API is REST over JSON. It mirrors the Resend API: the same paths, request
bodies, response shapes, and error envelope. Any Resend SDK works against it by changing
only the base URL.

## Base URL

Whatever host you deployed to:

```
https://outbox.example.com
```

Locally that is `http://localhost:3000`. Unlike Resend there is no separate `api.`
hostname — the API is served at the root and the dashboard lives under `/app`, so a base
URL swap is all an SDK needs.

## Authentication

Send your API key as a bearer token:

```
Authorization: Bearer ob_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are created in the dashboard or through [the API](/api/api-keys) and shown exactly
once. Only a SHA-256 hash is stored, so a lost key cannot be recovered — create a new one
and delete the old.

Keys carry a permission:

- **`full_access`** — every endpoint.
- **`sending_access`** — `POST /emails` and `POST /emails/batch` only. Every other
  endpoint returns `401 restricted_api_key`.

A key may also be restricted to one domain, in which case it can only send from that
domain.

## User-Agent

Every request must include a `User-Agent`. Requests without one are rejected:

```json
{
  "statusCode": 403,
  "name": "invalid_user_agent",
  "message": "The User-Agent header is required. Set it to identify your application, e.g. `my-app/1.0`."
}
```

Every official SDK and most HTTP clients set this automatically. Bare `curl` does too.
Explicitly clearing it — `curl -H "User-Agent:"` — is what trips this.

## Response codes

| Status | Meaning |
|---|---|
| `200` | Success |
| `201` | Created |
| `400` | Malformed request or bad parameter |
| `401` | Missing key, or a restricted key on a forbidden endpoint |
| `403` | Invalid key, unverified sending domain, or missing User-Agent |
| `404` | Resource not found |
| `409` | Conflict — a duplicate, or a concurrent idempotent request |
| `422` | Validation failed or a required field is missing |
| `429` | Rate limit exceeded |
| `5xx` | Server error |

## Errors

Every error uses the same envelope:

```json
{
  "statusCode": 422,
  "name": "missing_required_field",
  "message": "Missing `subject` field."
}
```

`name` is the stable machine-readable slug — switch on it rather than parsing `message`.
See [Errors](/api/errors) for the full list.

## Rate limits

The default is **10 requests per second per team**, shared across all of that team's API
keys, matching Resend's default. Change it with `RATE_LIMIT_PER_SECOND`.

Exceeding it returns 429 with the standard headers:

```
retry-after: 1
ratelimit-limit: 10
ratelimit-remaining: 0
ratelimit-reset: 1
```

Back off and retry. A client that ignores 429s will drop requests.

## Pagination

List endpoints return a consistent envelope and use cursor pagination. See
[Pagination](/api/pagination).

```json
{
  "object": "list",
  "has_more": false,
  "data": []
}
```

## Idempotency

`POST /emails` and `POST /emails/batch` accept an `Idempotency-Key` header. Repeating a
request with the same key replays the original response instead of sending again — see
[Emails](/api/emails#idempotency).

## Endpoints

| Group | Paths |
|---|---|
| [Emails](/api/emails) | `/emails`, `/emails/batch`, `/emails/:id`, `/emails/receiving` |
| [Domains](/api/domains) | `/domains` |
| [API keys](/api/api-keys) | `/api-keys` |
| [Contacts](/api/contacts) | `/contacts` |
| [Contact properties](/api/contact-properties) | `/contact-properties` |
| [Segments](/api/segments) | `/segments`, `/audiences` |
| [Topics](/api/topics) | `/topics` |
| [Broadcasts](/api/broadcasts) | `/broadcasts` |
| [Templates](/api/templates) | `/templates` |
| [Suppressions](/api/suppressions) | `/suppressions` |
| [Webhooks](/api/webhooks) | `/webhooks` |
| [Automations](/api/automations) | `/automations`, `/events/send` |
| [Metrics](/api/metrics) | `/emails/metrics`, `/segments/metrics` |
| [Logs](/api/logs) | `/logs` |
