---
title: Concepts
description: How teams, domains, contacts, topics, and the job queue fit together.
section: Getting started
order: 2
---

# Concepts

A short tour of the objects Outbox works with and how they relate.

## Teams and accounts

Everything is scoped to a **team**. API keys, domains, contacts, emails, and templates
all belong to exactly one team, and no query crosses that boundary.

A **user** signs in to the dashboard and belongs to one or more teams through a
**membership** carrying a role (`owner`, `admin`, `member`).

The first account created on an instance is the **instance owner** (`is_owner`). That is
a property of the installation, distinct from being the owner of a team. It is enforced
by a partial unique index, so two simultaneous signups on a fresh instance cannot both
claim it.

## API keys

Keys are shown once, at creation, and stored only as a SHA-256 hash. They carry a
permission:

- `full_access` — every endpoint.
- `sending_access` — only the send endpoints. Suitable for a key that ships somewhere
  less trusted.

A key can additionally be restricted to a single domain, in which case it may only send
from that domain.

The dashboard authenticates with a session cookie against the *same* endpoints, so there
is no second API to keep in sync.

## Domains

You must add and verify a domain before Outbox will deliver mail from it. Adding one
generates a DKIM keypair and the DNS records to publish:

| Record | Type | Purpose |
|---|---|---|
| `@` and `send` | TXT | SPF authorising this host |
| `send` | MX | Return path for bounces |
| `outbox._domainkey` | TXT | DKIM public key |
| `_dmarc` | TXT | DMARC policy, starting at `p=none` |
| `links` | CNAME | Click and open tracking, when tracking is enabled |
| `@` | MX | Inbound mail, when receiving is enabled |

Verification resolves each record and compares it. A domain becomes `verified` once SPF
and DKIM check out; tracking and receiving records are advisory. From that point
outbound mail is DKIM-signed.

See [Verify a domain](/tutorials/verify-a-domain).

## Emails

An email is created synchronously — validated, persisted, and queued — and the API
returns its id immediately. Delivery happens in the worker.

Its state lives in `last_event`, which mirrors the webhook event names without the
`email.` prefix:

```
queued → scheduled → sent → delivered → opened → clicked
                        ↘ bounced / complained / failed / suppressed / canceled
```

Terminal states never regress. An open arriving after a bounce does not overwrite the
bounce.

Every state change writes a row to `email_events`, which is what the metrics endpoint
aggregates over.

## Contacts, segments, and topics

A **contact** is a person, unique by email within a team, with optional first and last
names, an `unsubscribed` flag, and typed **contact properties** you define.

A **segment** is a named group of contacts. Broadcasts target a segment.

A **topic** is a subscription category — "Weekly newsletter", "Product updates" —
letting recipients opt out of one kind of mail without opting out of everything. Each
topic has a `default_subscription` of `opt_in` or `opt_out` that applies to anyone who
has not expressed a preference.

Sending with a `topic_id` gates each recipient:

| Recipient | Outcome |
|---|---|
| Contact who opted in | Sent |
| Contact who opted out | Skipped, `email.failed` |
| Not a contact | Follows the topic's `default_subscription` |

## Suppressions

The suppression list is the team's do-not-send list. Addresses land on it three ways:

- `bounce` — a hard bounce, added automatically.
- `complaint` — a spam report.
- `manual` — added through the API or dashboard.

Every send checks it per recipient. A suppressed address produces `email.suppressed` and
is not delivered, which protects your sending reputation from repeatedly hitting a dead
address.

## Templates

A template holds content out of your codebase. Each edit creates a new **version**;
publishing promotes a version to `current_version_id`. Sends always use the published
version, so editing a template cannot break production mid-flight.

Variables use triple mustaches with an optional inline fallback:

```html
<p>Hi {{{first_name|there}}}, your order of {{{PRODUCT}}} shipped.</p>
```

Declared variables can carry a typed fallback used when a value is missing. Double
braces (`{{name}}`) HTML-escape; triple braces do not.

## Broadcasts

A broadcast is one message sent to every contact in a segment. Fan-out happens in the
worker: each eligible contact gets a real email row, personalised with their own values,
so per-recipient tracking and metrics work exactly as they do for transactional mail.

Contacts are skipped, with a recorded reason, when they are unsubscribed, suppressed, or
opted out of the broadcast's topic.

## Automations

An automation is a graph. **Steps** do things and **edges** connect them:

| Step | Behaviour |
|---|---|
| `trigger` | Entry point, matched on a custom event name |
| `condition` | Branches on `condition_met` / `condition_not_met` edges |
| `delay` | Suspends the run and resumes later |
| `wait_for_event` | Suspends until a named event arrives |
| `send_email` | Sends, inline or from a template |
| `add_to_segment` | Adds the contact to a segment |
| `contact_update` | Updates contact fields |
| `contact_delete` | Deletes the contact |

You start a run by posting to `/events/send`. Delays and waits suspend the run rather
than holding a worker, so a 30-day drip campaign costs nothing while it waits.

See [Build a welcome automation](/tutorials/welcome-automation).

## Webhooks

Webhooks deliver events to your endpoint, signed with the Svix scheme so the standard
Svix libraries verify them unchanged. Failures retry with exponential backoff across
roughly a day, and every attempt is recorded with its status code and response body.

See [Handle webhooks](/tutorials/handle-webhooks) and [Webhooks API](/api/webhooks).

## The job queue

Anything that must not happen inside a request — delivery, broadcast fan-out, webhook
posts, automation steps, DNS verification — goes through a Postgres-backed queue.

Workers claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`, so you can run as many as you
like without coordination. Failed jobs retry with exponential backoff up to
`max_attempts`, and jobs whose worker died mid-flight are reclaimed after five minutes.

That is why `bun run dev` starts a worker alongside the API: without one, mail is
accepted and queued but never sent.
