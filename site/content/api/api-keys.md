---
title: API keys
description: Create, list, and delete API keys, with permission and domain scoping.
section: API reference
order: 13
---

# API keys

## Create an API key

```
POST /api-keys
```

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | **Required** |
| `permission` | `string` | `full_access` (default) or `sending_access` |
| `domain_id` | `string` | Restrict the key to one sending domain |

```sh
curl -X POST https://outbox.example.com/api-keys \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Production", "permission": "sending_access" }'
```

```json
{
  "id": "dacf4072-4119-4d88-932f-6202748ac7c8",
  "token": "ob_EXAMPLEKEYdonotusethisvalue456"
}
```

> The token is returned exactly once. Outbox stores only a SHA-256 hash, so it cannot be
> shown again — if you lose it, create a new key and delete the old one.

### Permissions

| Permission | Reach |
|---|---|
| `full_access` | Every endpoint |
| `sending_access` | `POST /emails` and `POST /emails/batch` only |

A `sending_access` key calling anything else gets:

```json
{
  "statusCode": 401,
  "name": "restricted_api_key",
  "message": "This API key is restricted to only send emails. Use a full access key for this operation."
}
```

Use `sending_access` for keys that live anywhere you would not want a full-access
credential — edge functions, CI, a service that only ever sends.

### Domain restriction

Passing `domain_id` limits the key to sending from that domain. Attempting to send from
another returns `403 invalid_api_key`. Useful in multi-tenant setups where each tenant
sends from their own domain.

## List API keys

```
GET /api-keys
```

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "id": "91c4b0f1-2ad7-4e8b-9a0d-cf6d3c1a0e19",
      "name": "Production",
      "created_at": "2026-04-08 00:11:13.110779+00"
    }
  ]
}
```

Tokens are never included. Pagination is optional.

## Delete an API key

```
DELETE /api-keys/:api_key_id
```

```json
{}
```

Deletion is immediate — in-flight requests using that key will fail. Emails already sent
with it are unaffected; their `api_key_id` is nulled.

## Rotating a key

There is no rotate endpoint, because rotation is two calls and doing it explicitly
avoids a window where neither key works:

1. `POST /api-keys` to create the replacement.
2. Deploy it.
3. `DELETE /api-keys/:id` for the old one.

Check the [logs](/api/logs) between steps 2 and 3 to confirm nothing is still using the
old key.
