---
title: Outbox
description: Open source email API and dashboard. A self-hostable Resend, built on Bun, Atlas, and PostgreSQL.
section: Getting started
order: 0
---

<div class="hero">

# Outbox

<p class="tagline">Open source email API and dashboard. A self-hostable Resend.</p>

</div>

Outbox implements the Resend API surface — the same paths, request bodies, response
shapes, and error envelope — plus the dashboard that goes with it. Point any Resend
SDK at your Outbox host and it works unchanged.

```ts
import { Resend } from "resend"

// The only change is the base URL.
const resend = new Resend("ob_yourapikey", { baseUrl: "https://outbox.example.com" })

await resend.emails.send({
  from: "Acme <onboarding@yourdomain.com>",
  to: ["someone@example.com"],
  subject: "Hello World",
  html: "<strong>It works!</strong>",
})
```

<div class="cards">
  <a class="card" href="/quickstart">
    <h3>Quickstart →</h3>
    <p>Running locally and sending your first email in about five minutes.</p>
  </a>
  <a class="card" href="/api/introduction">
    <h3>API reference →</h3>
    <p>Every endpoint, with request and response shapes.</p>
  </a>
  <a class="card" href="/tutorials/migrate-from-resend">
    <h3>Migrate from Resend →</h3>
    <p>What changes, what doesn't, and how to cut over.</p>
  </a>
  <a class="card" href="/self-hosting">
    <h3>Self-hosting →</h3>
    <p>Transports, DNS, deployment, and the operational realities of email.</p>
  </a>
</div>

## What's in it

**Sending** — transactional email, batch send (100 per call), scheduling with natural
language (`in 1 hour`) or ISO 8601, attachments, inline images, custom headers, tags,
idempotency keys, and cancel/reschedule of queued sends.

**Domains** — per-domain DKIM keypairs, generated SPF/DKIM/DMARC/MX/tracking records,
live DNS verification, open and click tracking, custom return path, opportunistic or
enforced TLS.

**Audience** — contacts with typed custom properties, segments, topics with per-contact
opt-in and opt-out, and a suppression list that bounces feed automatically.

**Broadcasts** — fan out to a segment with per-contact personalisation, scheduling, and
per-broadcast metrics including clicked links.

**Templates** — versioned, with typed variables and fallbacks, a draft/publish workflow,
duplication, and addressing by id or alias.

**Automations** — event-triggered workflows as a step graph: conditions with branching,
delays, waiting on an event, sending email, and mutating contacts.

**Webhooks** — 19 event types, Svix-compatible signatures, delivery attempt history, and
exponential-backoff retries.

**Receiving** — an inbound SMTP server that parses MIME, stores attachments, and fires
`email.received`.

**Accounts** — the first account created on an instance owns it; later signups get their
own team. Sessions are cookie-based and revocable.

## Why it exists

Resend is a good product with an API worth copying. Outbox exists for the cases where
sending someone else's servers your customers' email is the wrong answer: air-gapped
deployments, data-residency requirements, high volume where per-email pricing stops
making sense, or simply wanting the thing you depend on to be inspectable.

The compatibility is the point. You should be able to develop against Resend and deploy
against Outbox, or the reverse, without a rewrite.

## How it differs

Outbox is not a proxy in front of SES — it delivers mail itself, so a few things
necessarily differ:

| | Resend | Outbox |
|---|---|---|
| API key prefix | `re_` | `ob_` |
| DNS record values | Point at SES | Point at your host |
| Billing | Metered | None — it's your server |
| Regions | Routed | Stored and returned, single region |

The record *set* is the same shape, the API is the same, and errors use the same
envelope. See [Migrate from Resend](/tutorials/migrate-from-resend) for the full list.

## For agents

The docs are available as plain text: [llms.txt](/llms.txt) for an index, and
[llms-full.txt](/llms-full.txt) for everything in one file. Any page also serves its
raw markdown by appending `.md` to the URL.
