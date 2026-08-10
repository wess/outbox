---
title: Handle bounces
description: Process delivery failures and spam complaints that arrive after a message was accepted.
section: Tutorials
order: 37
---

# Handle bounces

Most bounces do not happen during the SMTP conversation. A receiving server
usually says `250 accepted`, discovers afterwards that the mailbox is unknown or
full, and mails a report back to your return path. Spam complaints work the same
way — the recipient hits "report spam" days later and their provider tells you.

Outbox processes both, and feeds the results into the suppression list so you
stop mailing addresses that no longer work.

## How attribution works

Every message Outbox sends carries a VERP return path:

```
bounces+4ef9a417-02e9-4d39-ad75-9611e0fcc33c@send.acme.com
```

The tag is the email's id. When a report comes back, that is what ties it to the
message that caused it — more reliably than the returned `Message-ID`, because
plenty of mail servers return only a truncated body and some return nothing at
all. Outbox falls back to the `Message-ID` when the tag is missing.

## What you need running

Bounce processing happens on the **inbound SMTP server**, so it has to be
listening:

```sh
INBOUND_ENABLED=true
INBOUND_PORT=2525
```

```sh
bun run dev        # starts it alongside the API and worker
# or
bun run inbound    # on its own
```

Forward port 25 to it, as in [Receive inbound
email](/tutorials/receive-inbound-email).

> You do **not** need to enable receiving on the domain. Bounce addresses are
> routed on their own, so you can process bounces without accepting ordinary
> mail. Enabling `receiving` is a separate decision about a separate thing.

The worker warns at startup if you are delivering with the `smtp` transport and
have no inbound server, because that combination silently loses every
asynchronous bounce.

### DNS

Adding a domain already generates the record this needs:

| Record | Type | Host | Value |
|---|---|---|---|
| SPF | MX | `send.acme.com` | `feedback-smtp.<your host>` priority 10 |

That MX is what tells the world where to send reports. If it does not resolve to
your inbound server, bounces go nowhere.

## What happens to a bounce

| Report | Severity | Outbox does |
|---|---|---|
| DSN status `5.x.x`, or a `5xx` diagnostic | hard | `email.bounced`, suppress the address |
| DSN status `4.x.x`, or `Action: delayed` | soft | `email.delivery_delayed`, record it, **no** suppression |
| ARF feedback report | complaint | `email.complained`, suppress the address |
| ARF `Feedback-Type: not-spam` | — | Nothing. It is a retraction, not a complaint |
| Anything unparseable at a bounce address | soft | Recorded as a transient failure |

The last row matters: arriving at a bounce address is itself evidence something
failed, so an unrecognised format is still recorded rather than dropped. It is
treated as soft because "we cannot tell what went wrong" is not grounds for
permanently blocking an address.

A soft bounce never suppresses. Mailbox-full and greylisting are temporary, and
suppressing on them would lose you real recipients.

## Watching it

Subscribe to the events:

```sh
curl -X POST https://outbox.example.com/webhooks \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "https://acme.com/webhooks/outbox",
    "events": ["email.bounced", "email.complained", "email.delivery_delayed"]
  }'
```

```json
{
  "type": "email.bounced",
  "created_at": "2026-08-10T15:41:02.114Z",
  "data": {
    "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    "to": ["dead@example.com"],
    "bounce": {
      "type": "Permanent",
      "status": "5.1.1",
      "message": "smtp; 550 5.1.1 <dead@example.com>: User unknown"
    },
    "reporting_mta": "mx.example.net"
  }
}
```

Mirror hard bounces into your own user records. Outbox will not mail the address
again, but only your application knows to stop *asking* it to.

## Reading the suppression list

```sh
curl "https://outbox.example.com/suppressions?origin=bounce" \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{
  "id": "…",
  "email": "dead@example.com",
  "origin": "bounce",
  "source_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  "created_at": "2026-08-10 15:41:02.114+00"
}
```

`source_id` is the email that caused it, so "why is this address blocked" has an
answer rather than a guess.

## On the relay transport

If `OUTBOX_TRANSPORT=relay`, your upstream provider receives the bounces, not
you — the return path they use is theirs. Configure bounce forwarding on their
side, or use their webhooks. The inbound server here only sees what is addressed
to it.

## Testing it

The repo ships an end-to-end check that delivers real DSN and ARF messages to
the inbound server and asserts the outcome:

```sh
OUTBOX_API_KEY=ob_... bun run test:bounce
```

It covers a hard bounce suppressing an address, a later send to that address
being blocked, a soft bounce *not* suppressing, an ARF complaint suppressing, and
ordinary mail still being refused when receiving is off.

## Troubleshooting

**Bounces arrive but nothing happens.** Check the inbound server is running and
that the recipient really is a `bounces+…@<return path>.<domain>` address. The
log prints a line per report it processes.

**"could not attribute the report to a sent email".** The VERP tag was stripped —
some forwarders rewrite the envelope — and the report carried no usable
`Message-ID`. Nothing can be done for that individual report.

**"report named no recipient and the email had several".** A DSN that does not
name the failed address cannot be applied to a message sent to several people
without guessing which one failed, so Outbox declines to guess.

**Addresses suppressed that should not be.** Check the `origin` and `source_id`,
then remove them — see [Suppressions](/api/suppressions). If it is happening in
volume, the reports are probably being misclassified; the diagnostic is recorded
in `reason`.
