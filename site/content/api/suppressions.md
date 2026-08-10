---
title: Suppressions
description: The team do-not-send list that bounces and complaints feed automatically.
section: API reference
order: 20
---

# Suppressions

The suppression list protects your sending reputation. Every send checks it per
recipient, so an address that hard-bounced once is not retried into a wall.

## How addresses land here

| `origin` | Cause |
|---|---|
| `bounce` | A permanent delivery failure. Added automatically |
| `complaint` | A spam report |
| `manual` | Added through the API or dashboard |

Automatic suppression is the important one. Repeatedly mailing addresses that hard-bounce
is one of the fastest ways to damage a sending domain, and it is entirely avoidable.

## Add a suppression

```
POST /suppressions
```

```json
{ "email": "bounced@example.com" }
```

```json
{
  "object": "suppression",
  "id": "e169aa45-1ecf-4183-9955-b1499d5701d3",
  "email": "bounced@example.com"
}
```

Adding an address that is already suppressed updates its origin rather than failing.

## Add up to 100

```
POST /suppressions/batch/add
```

```json
{ "emails": ["a@example.com", "b@example.com"] }
```

```json
{
  "object": "list",
  "data": [
    { "id": "…", "email": "a@example.com" },
    { "id": "…", "email": "b@example.com" }
  ]
}
```

Useful when importing a do-not-contact list from another provider — do that before your
first send, not after.

## Retrieve a suppression

```
GET /suppressions/:suppression
```

Accepts an id or an email address.

```json
{
  "id": "e169aa45-1ecf-4183-9955-b1499d5701d3",
  "email": "bounced@example.com",
  "origin": "bounce",
  "source_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  "created_at": "2026-10-06 23:47:56.678+00"
}
```

`source_id` is the email that caused it, for `bounce` and `complaint` origins, and
`null` for manual entries. It answers "why is this address blocked" without guessing.

## List suppressions

```
GET /suppressions
GET /suppressions?origin=bounce
```

Always paginated. `origin` filters to `bounce`, `complaint`, or `manual`.

## Remove a suppression

```
DELETE /suppressions/:suppression
```

Accepts an id or an email.

## Remove up to 100

```
POST /suppressions/batch/remove
```

```json
{ "emails": ["a@example.com"], "ids": ["e169aa45-…"] }
```

Either or both keys. Returns what was actually removed.

## When to remove

Removing a `manual` entry is routine — someone asked to be re-added.

Removing a `bounce` entry deserves a reason. If the mailbox genuinely came back (a
typo'd domain now registered, a mailbox un-suspended), fine. If you are removing it
because the numbers look bad, you are choosing to re-send to an address that already
told you it does not exist, and receiving servers notice.

`complaint` entries should essentially never be removed. Someone marked your mail as
spam; mailing them again is how domains get blocklisted.

## Suppression and unsubscribe

These are different mechanisms and it is worth keeping them straight:

| | Suppression list | `unsubscribed` flag | Topic opt-out |
|---|---|---|---|
| Scope | Every email | Broadcasts only | One topic |
| Set by | Bounces, complaints, you | Contact or unsubscribe link | Contact or unsubscribe link |
| Blocks transactional | Yes | No | Only if sent with that topic |

A password reset should still reach someone who unsubscribed from marketing. It should
not reach an address that does not exist. That is the distinction.

## Events

`suppression.added` and `suppression.removed` fire to subscribed
[webhooks](/api/webhooks).
