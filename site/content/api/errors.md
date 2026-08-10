---
title: Errors
description: The error envelope and every error name Outbox returns.
section: API reference
order: 26
---

# Errors

Every error uses the same envelope:

```json
{
  "statusCode": 422,
  "name": "missing_required_field",
  "message": "Missing `subject` field."
}
```

Switch on `name`. It is the stable machine-readable slug; `message` is written for humans
and may change.

## Reference

### 400

| `name` | Cause |
|---|---|
| `validation_error` | The request body failed schema validation |
| `invalid_parameter` | A parameter had an unacceptable value |
| `invalid_idempotency_key` | The key was empty or longer than 256 characters |
| `invalid_idempotent_request` | The same idempotency key was reused with a different body |

### 401

| `name` | Cause |
|---|---|
| `missing_api_key` | No `Authorization` header |
| `restricted_api_key` | A `sending_access` key called a non-send endpoint |
| `invalid_access` | A dashboard endpoint was called without a session |

### 403

| `name` | Cause |
|---|---|
| `invalid_api_key` | The key does not exist, or is domain-restricted and was used elsewhere |
| `invalid_user_agent` | No `User-Agent` header |
| `invalid_from_address` | `from` is malformed, its domain is unverified, or sending is disabled for it |

### 404

| `name` | Cause |
|---|---|
| `not_found` | The resource, or the endpoint, does not exist |

### 409

| `name` | Cause |
|---|---|
| `concurrent_idempotent_requests` | The original request with this key is still in flight |
| `invalid_parameter` | A uniqueness constraint was violated — a duplicate |

### 422

| `name` | Cause |
|---|---|
| `missing_required_field` | A required field was absent |
| `validation_error` | The body did not match the expected shape |
| `invalid_attachment` | Missing content, a blocked extension, or over the size limit |
| `invalid_access` | The operation is not permitted on this resource |

### 429

| `name` | Cause |
|---|---|
| `rate_limit_exceeded` | More than `RATE_LIMIT_PER_SECOND` requests in a second |

### 5xx

| `name` | Cause |
|---|---|
| `application_error` | An unhandled server error. Check the server log |

## Handling them

```ts
const res = await fetch(`${base}/emails`, { method: "POST", headers, body })

if (!res.ok) {
  const error = await res.json()

  switch (error.name) {
    case "rate_limit_exceeded": {
      const wait = Number(res.headers.get("retry-after") ?? 1) * 1000
      await new Promise((r) => setTimeout(r, wait))
      return retry()
    }
    case "invalid_from_address":
      // Not retryable — verify the domain first.
      throw new Error(error.message)
    case "missing_required_field":
    case "validation_error":
      // A bug in the caller. Do not retry.
      throw new Error(error.message)
    default:
      if (res.status >= 500) return retryWithBackoff()
      throw new Error(error.message)
  }
}
```

### What to retry

| Retry | Do not retry |
|---|---|
| `429` — after `retry-after` | `4xx` validation and auth errors |
| `5xx` — with backoff | `invalid_from_address` |
| Network timeouts — with an idempotency key | `restricted_api_key` |

Always use an [idempotency key](/api/emails#idempotency) when retrying a send. A timeout
does not tell you whether the message was accepted, and retrying without one is how
people send the same receipt twice.

## Common mistakes

**403 `invalid_user_agent`** — you cleared the header. Set it to something identifying
your application.

**403 `invalid_from_address` in production but not locally** — locally you were on the
`console` transport, which skips the domain check. Verify the domain.

**422 `validation_error` with an SDK** — usually a camelCase key that reached the wire
unconverted. Check `request_body` in the [logs](/api/logs).

**409 `concurrent_idempotent_requests`** — two identical requests raced. Wait and retry;
the first will have completed.
