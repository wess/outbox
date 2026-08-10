---
title: Domains
description: Add, verify, configure, and delete sending domains.
section: API reference
order: 12
---

# Domains

A domain must be added and verified before Outbox will deliver mail from it. Adding one
generates a DKIM keypair and the DNS records you need to publish.

## Create a domain

```
POST /domains
```

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | **Required.** The domain, e.g. `acme.com` |
| `region` | `string` | Stored and returned; a self-hosted install has one region |
| `custom_return_path` | `string` | Subdomain for the bounce path. Default `send` |
| `open_tracking` | `boolean` | Default `false` |
| `click_tracking` | `boolean` | Default `false` |
| `tracking_subdomain` | `string` | Default `links` |
| `tls` | `string` | `opportunistic` or `enforced` |
| `capabilities` | `object` | `{ sending, receiving }`, each `enabled` or `disabled` |

```sh
curl -X POST https://outbox.example.com/domains \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "acme.com", "open_tracking": true, "click_tracking": true }'
```

```json
{
  "object": "domain",
  "id": "d91cd9bd-1176-453e-8fc1-35364d380206",
  "name": "acme.com",
  "status": "not_started",
  "created_at": "2026-04-26 20:21:26.347412+00",
  "region": "us-east-1",
  "open_tracking": true,
  "click_tracking": true,
  "tracking_subdomain": "links",
  "tls": "opportunistic",
  "custom_return_path": "send",
  "capabilities": { "sending": "enabled", "receiving": "disabled" },
  "records": [
    {
      "record": "SPF",
      "name": "send",
      "type": "MX",
      "ttl": "Auto",
      "status": "not_started",
      "value": "feedback-smtp.mail.example.com",
      "priority": 10
    },
    {
      "record": "DKIM",
      "name": "outbox._domainkey",
      "type": "TXT",
      "ttl": "Auto",
      "status": "not_started",
      "value": "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ..."
    }
  ]
}
```

> The record **values** point at your installation rather than at SES, so they differ
> from Resend's. The record **set** and the API shape are the same.

### Records

| `record` | Type | Purpose |
|---|---|---|
| `SPF` | TXT at `@` and `send` | Authorises this host to send |
| `SPF` | MX at `send` | Return path for bounces |
| `DKIM` | TXT at `outbox._domainkey` | Public key for signature verification |
| `DMARC` | TXT at `_dmarc` | Policy, starting at `p=none` |
| `Tracking` | CNAME at `links` | Only when open or click tracking is on |
| `MX` | MX at `@` | Only when receiving is enabled |

The DKIM key is 1024-bit so the TXT record fits in a single DNS string. That is
sufficient for both transactional and marketing mail.

## Verify a domain

```
POST /domains/:domain_id/verify
```

Resolves every record and updates its status.

```json
{
  "object": "domain",
  "id": "d91cd9bd-1176-453e-8fc1-35364d380206",
  "status": "verified",
  "records": [ /* each with an updated status */ ]
}
```

| `status` | Meaning |
|---|---|
| `not_started` | Nothing resolves yet |
| `pending` | Some records resolve |
| `verified` | SPF and DKIM both resolve — sending is enabled |
| `failed` | Nothing resolved on the last check |

Tracking and receiving records are advisory and do not gate verification. DNS
propagation can take minutes to hours; re-run verify rather than assuming failure.

## Retrieve a domain

```
GET /domains/:domain_id
```

Returns the domain with its current records.

## List domains

```
GET /domains
```

Pagination is optional — omit `limit` to get everything. List items are trimmed to `id`,
`name`, `status`, `created_at`, and `region`.

## Update a domain

```
PATCH /domains/:domain_id
```

| Field | Notes |
|---|---|
| `click_tracking` | Rewrites links through your tracking subdomain |
| `open_tracking` | Injects a tracking pixel |
| `tracking_subdomain` | |
| `tls` | `opportunistic` or `enforced` |
| `custom_return_path` | |
| `capabilities` | `{ sending, receiving }` |

Toggling tracking or receiving changes which DNS records apply, so the record set is
rebuilt. Records that did not move keep their verification status.

`tls: "enforced"` refuses to deliver to a server that will not negotiate STARTTLS. That
is a deliverability trade — some receivers still do not support it.

## Delete a domain

```
DELETE /domains/:domain_id
```

Deleting a domain deletes its DKIM keys. Re-adding it generates new ones and requires
publishing DNS again.

## Events

`domain.created`, `domain.updated`, and `domain.deleted` fire to subscribed
[webhooks](/api/webhooks).
