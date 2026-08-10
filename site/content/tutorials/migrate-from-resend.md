---
title: Migrate from Resend
description: What changes, what doesn't, and how to cut over without dropping mail.
section: Tutorials
order: 32
---

# Migrate from Resend

The API is the same. In most codebases the migration is one line — the base URL — plus
the operational work of standing up a server and moving your data.

## What stays the same

- Every endpoint path, request body, and response shape.
- The error envelope: `{ statusCode, name, message }`.
- The list envelope: `{ object, has_more, data }` with `after`/`before` cursors.
- Webhook event names and payloads.
- Webhook signatures — Svix scheme, so the same verification code works.
- Template variable syntax, including `{{{RESEND_UNSUBSCRIBE_URL}}}`.
- The `/audiences` paths, alongside `/segments`.

## What changes

| | Resend | Outbox |
|---|---|---|
| Base URL | `https://api.resend.com` | Your host |
| API key prefix | `re_` | `ob_` |
| DNS record values | Point at SES | Point at your host |
| Billing | Metered | None |
| Regions | Routed | Stored, single region |
| SMTP submission | Available | Not supported — use the HTTP API |

The DNS difference is the one with real work attached: you cannot reuse Resend's records
because they authorise Resend's servers. New domain, new records, new verification.

## 1. Stand up Outbox

Follow [self-hosting](/self-hosting). Decide your transport before you migrate: `relay`
if you want someone else to own IP reputation, `smtp` if you are prepared to run an MTA.

Set `PUBLIC_URL` to the externally reachable URL — tracking and unsubscribe links are
built from it.

## 2. Move your data

There is no import endpoint. Read from Resend, write to Outbox.

### Contacts

```ts
import { Resend } from "resend"

const source = new Resend(process.env.RESEND_API_KEY)
const target = new Resend(process.env.OUTBOX_API_KEY, { baseUrl: process.env.OUTBOX_URL })

const segment = await target.audiences.create({ name: "Migrated" })

let after: string | undefined
for (;;) {
  const page = await source.contacts.list({ audienceId: RESEND_AUDIENCE_ID, limit: 100, after })
  for (const contact of page.data.data) {
    await target.contacts.create({
      email: contact.email,
      firstName: contact.first_name,
      lastName: contact.last_name,
      unsubscribed: contact.unsubscribed,
      audienceId: segment.data.id,
    })
  }
  if (!page.data.has_more) break
  after = page.data.data[page.data.data.length - 1].id
}
```

Create [contact properties](/api/contact-properties) on Outbox first — unknown keys are
rejected rather than dropped.

### Suppressions

**Do this before your first send.** Everyone who bounced or complained on Resend must
stay suppressed, or you will re-mail dead addresses from a domain with no reputation —
the worst possible opening move.

```ts
const suppressions = await source.suppressions.list({ limit: 100 })
await target.suppressions.batch.add(suppressions.data.data.map((s) => s.email))
```

### Templates

Recreate them and publish. The variable syntax is identical, so the bodies copy across
unchanged.

### Broadcasts and emails

Historical sends do not migrate. Keep your Resend account readable for a while if you
need the archive.

## 3. Point your code at Outbox

```diff
- const resend = new Resend(process.env.RESEND_API_KEY)
+ const resend = new Resend(process.env.OUTBOX_API_KEY, {
+   baseUrl: process.env.OUTBOX_URL,
+ })
```

Better, make it switchable so you can fall back without a deploy:

```ts
export const mailer = new Resend(process.env.MAIL_API_KEY, {
  ...(process.env.MAIL_BASE_URL ? { baseUrl: process.env.MAIL_BASE_URL } : {}),
})
```

Unset `MAIL_BASE_URL` and you are on Resend; set it and you are on Outbox.

## 4. Verify domains

New records, new verification — see [Verify a domain](/tutorials/verify-a-domain). Use a
different subdomain from the one Resend uses so both can run at once during cutover.

## 5. Recreate webhooks

Signing secrets differ, so your endpoint needs Outbox's. If you want to run both
temporarily, accept either:

```ts
const secrets = [process.env.RESEND_WEBHOOK_SECRET, process.env.OUTBOX_WEBHOOK_SECRET]

let event = null
for (const secret of secrets.filter(Boolean)) {
  try {
    event = await verifyWebhook({ payload: raw, headers, webhookSecret: secret! })
    break
  } catch {}
}
if (!event) return new Response("bad signature", { status: 400 })
```

## 6. Cut over gradually

Move traffic by category rather than all at once:

```ts
const OUTBOX_CATEGORIES = new Set(["internal", "notifications"])

const client = OUTBOX_CATEGORIES.has(category) ? outbox : resend
```

Start with internal or low-stakes mail. Watch delivery, bounce, and complaint rates for a
week. Then move password resets and receipts, then marketing last — it is the most
sensitive to reputation.

## Verify the compatibility yourself

The repo ships a suite that runs the official `resend` package against Outbox:

```sh
OUTBOX_API_KEY=ob_... bun run test:compat
```

It checks sends, retrieval, listing, scheduling, cancellation, batching, audiences,
contacts, API keys, and error shapes. If you depend on a call it does not cover, add it
before you migrate.

## Rolling back

Keep the Resend key live until you are confident. Rollback is unsetting the base URL —
which is why making it an environment variable rather than a code change is worth the
five minutes.
