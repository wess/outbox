---
title: Verify a domain
description: Publish SPF, DKIM, and DMARC records so your mail authenticates and arrives.
section: Tutorials
order: 31
---

# Verify a domain

Outbox will not deliver from a domain you have not verified, and receiving servers would
mostly reject it anyway. This is the step that makes mail arrive.

## 1. Pick a domain

Use a subdomain, not your root domain:

```
mail.acme.com     ✓
send.acme.com     ✓
acme.com          ✗
```

Sending reputation attaches to the domain. Keeping bulk mail on a subdomain means a bad
month for your newsletter does not follow your invoices, and it keeps your existing MX
and SPF records untouched.

## 2. Add it

In the dashboard: **Domains → Add domain**. Or:

```sh
curl -X POST https://outbox.example.com/domains \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "mail.acme.com", "open_tracking": true, "click_tracking": true }'
```

Outbox generates a DKIM keypair and returns the records to publish.

## 3. Publish the records

| Record | Type | Host | Value |
|---|---|---|---|
| SPF | TXT | `mail.acme.com` | `"v=spf1 include:mail.example.com ~all"` |
| SPF | TXT | `send.mail.acme.com` | `"v=spf1 include:mail.example.com ~all"` |
| SPF | MX | `send.mail.acme.com` | `feedback-smtp.mail.example.com` priority 10 |
| DKIM | TXT | `outbox._domainkey.mail.acme.com` | `v=DKIM1; k=rsa; p=MIGfMA0…` |
| DMARC | TXT | `_dmarc.mail.acme.com` | `"v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com"` |
| Tracking | CNAME | `links.mail.acme.com` | `track.mail.example.com` |

The exact values come from your instance — copy them from the dashboard rather than this
page.

### Provider notes

Most DNS UIs want the host **relative** to the zone. If your zone is `acme.com`, enter
`outbox._domainkey.mail`, not the fully-qualified name. Entering the full name inside the
zone produces `outbox._domainkey.mail.acme.com.acme.com`, which is the single most common
reason verification fails.

Cloudflare: set DKIM, SPF, and DMARC records to **DNS only** (grey cloud). Proxying
breaks them.

## 4. Verify

```sh
curl -X POST https://outbox.example.com/domains/$DOMAIN_ID/verify \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{ "object": "domain", "id": "…", "status": "verified", "records": [ … ] }
```

| Status | Meaning |
|---|---|
| `not_started` | Nothing resolves yet |
| `pending` | Some records resolve |
| `verified` | SPF and DKIM both resolve — sending enabled |
| `failed` | Nothing resolved on the last check |

DNS propagation takes minutes to hours. Re-run verify rather than assuming failure.

Check what the world sees:

```sh
dig +short TXT outbox._domainkey.mail.acme.com
dig +short TXT mail.acme.com
dig +short TXT _dmarc.mail.acme.com
```

## 5. Send a real message

```sh
curl -X POST https://outbox.example.com/emails \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <hello@mail.acme.com>",
    "to": ["you@gmail.com"],
    "subject": "Authentication check",
    "html": "<p>Checking SPF, DKIM, and DMARC.</p>"
  }'
```

In Gmail, open the message → **Show original**. You want:

```
SPF:   PASS
DKIM:  PASS
DMARC: PASS
```

Anything else, fix before sending volume.

## 6. Tighten DMARC

Outbox starts you at `p=none`, which monitors without affecting delivery. Once you have
run a few weeks of clean traffic, tighten it:

```
v=DMARC1; p=none; rua=mailto:dmarc@acme.com       ← monitor
v=DMARC1; p=quarantine; pct=10; rua=…             ← 10% to spam
v=DMARC1; p=quarantine; rua=…                     ← all to spam
v=DMARC1; p=reject; rua=…                         ← reject outright
```

Move one step at a time and read the aggregate reports at `rua`. Jumping straight to
`p=reject` is how organisations discover, loudly, that some forgotten system was also
sending as their domain.

## Troubleshooting

**Verification never succeeds.** Confirm the record resolves publicly with `dig`. If
`dig` sees it and Outbox does not, your resolver may be caching an old negative response;
wait for the TTL.

**DKIM value looks truncated.** Some UIs split long TXT values across strings. Outbox uses
a 1024-bit key so the record fits in one, but if your provider wraps it anyway,
verification still passes — the check compares the `p=` tag, not the raw string.

**Verified, but Gmail says SPF fails.** SPF authenticates the return path, not the
visible `From`. Confirm the `send` subdomain records are published, not only the root.

**Mail lands in spam despite passing.** Authentication is necessary, not sufficient. New
domains have no reputation; volume has to ramp over weeks. Content, list quality, and
engagement matter as much as DNS.
