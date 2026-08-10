---
title: Connect Inkling
description: Pair Outbox with the Inkling CMS in one paste each direction — publish a post, subscribers get it.
section: Tutorials
order: 39
---

# Connect Inkling

[Inkling](https://github.com/wess/inkling) is a headless CMS built on the same stack as
Outbox. Connected, they give you the loop most newsletters want: write in the CMS, hit
publish, subscribers get it.

The pairing runs both ways and each direction is one command and one paste.

| Direction | Gives you |
|---|---|
| Inkling → Outbox | Inkling can send email at all — tests, notifications, and broadcasting an entry on publish |
| Outbox → Inkling | Outbox can read published content and build a broadcast from it |

You can set up one direction, the other, or both.

## Connection tokens

Both sides speak the same token format:

```
<prefix>_<base64url({ v, url, key, name })>
```

It carries the URL *and* the API key together, so there is one field to paste rather than
two to get subtly wrong. `obxc_` tokens are issued by Outbox; `inkc_` by Inkling. Pasting
one where the other belongs is caught with a message saying so.

> A token is a credential in plain text. It is shown once, should not be committed, and
> can be revoked by deleting the key it names.

---

## Inkling sends through Outbox

### 1. Issue a token from Outbox

```sh
bun run bin/outbox.ts connect
```

```
  Outbox connection token — paste this into the other service.

obxc_eyJ2IjoxLCJ1cmwiOiJodHRwOi8vbG9jYWxob3N0OjMwMDAiLCJrZXkiOiJvYl8…

  It carries http://localhost:3000 and a full-access API key named "Connection 2026-08-10".
```

Add `--send-only` for a key that can do nothing but send. The Inkling plugin also reads
segments, topics, and domains, so the default full-access key is what makes its settings
screen useful — use `--send-only` when you only want transactional sending.

### 2. Enable the plugin in Inkling

Admin → Plugins → **Outbox** → Enable. Then in **Outbox settings**:

| Setting | Value |
|---|---|
| Connection token | The `obxc_…` string |
| From address | `Acme <hello@mail.example.com>` — a domain [verified in Outbox](/tutorials/verify-a-domain) |
| Public site URL | `https://example.com`, used to link entries |

The **Email** panel now reports connection health, and warns if no sending domain is
verified yet.

### 3. Send a test

```sh
curl -X POST http://127.0.0.1:4300/ext/outbox/test \
  -H "Authorization: Bearer $INKLING_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "to": "you@example.com" }'
```

Or use the panel in the admin. Either way it goes out through Outbox and appears in your
Emails list.

### 4. Broadcast on publish

Set these in the plugin settings and publishing an entry sends it to a segment:

| Setting | Value |
|---|---|
| Broadcast on publish | on |
| Types to broadcast | `post` — comma-separated, empty means every type |
| Segment | An Outbox segment id |
| Topic | Optional. Lets people opt out of the newsletter without unsubscribing entirely |

The plugin's **targets** endpoint lists your Outbox segments and topics, so you can copy
an id without switching apps:

```sh
curl -H "Authorization: Bearer $INKLING_TOKEN" http://127.0.0.1:4300/ext/outbox/targets
```

Publish an entry and the log shows it:

```
[plugin:outbox] broadcast 066e9ccf-cf89-4244-9d33-af6a528e1855 queued for the-widget
```

A failed broadcast never fails the publish. It is logged and the entry goes live
regardless — losing a post because an email server was down would be the wrong trade.

---

## Outbox reads Inkling content

### 1. Issue a token from Inkling

```sh
bun run connect
```

```
  Inkling connection token — paste this into the other service.

inkc_eyJ2IjoxLCJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjQzMDAiLCJrZXkiOiJpbmtf…
```

Scope it to particular types if you like:

```sh
bun run connect --scopes post,announcement
```

### 2. Paste it into Outbox

In the dashboard: **Integrations → Inkling → Connect**. Add your public site URL so
emails link back to the article.

Or from the command line:

```sh
bun run bin/outbox.ts connect inkling inkc_…
```

```
connected to inkling at http://127.0.0.1:4300 — 2 content types readable
```

The credential is verified before it is stored, so a bad paste fails immediately with a
usable message rather than at the first send.

### 3. Build a broadcast from an entry

```sh
curl -X POST https://outbox.example.com/broadcasts \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "segment_id": "78261eea-8f8b-4381-83c6-79fa7120f1cf",
    "from": "Acme <news@mail.example.com>",
    "source": { "provider": "inkling", "type": "post", "slug": "the-widget" },
    "send": true
  }'
```

`source` fills in the subject, HTML, and text from the published entry. Anything you pass
explicitly still wins, so overriding just the subject is one extra field.

The Integrations page browses your published content and previews exactly what a
broadcast would send.

---

## API reference

| Endpoint | Purpose |
|---|---|
| `POST /integrations/connect` | Pair from a token: `{ provider, token, settings? }` |
| `GET /integrations` | List connections |
| `GET /integrations/:provider` | One connection |
| `POST /integrations/:provider/check` | Re-probe and record health |
| `PATCH /integrations/:provider` | Update settings, e.g. `site_url` |
| `DELETE /integrations/:provider` | Disconnect |
| `GET /integrations/inkling/types` | Readable content types |
| `GET /integrations/inkling/content/:type` | Published entries |
| `GET /integrations/inkling/content/:type/:slug/preview` | Rendered email, unsent |

API keys are never returned by any of these.

## Troubleshooting

**"This is a `obxc` token; a `inkc` token was expected."** The tokens went the wrong way.
`obxc_` goes into Inkling; `inkc_` comes back to Outbox.

**"Could not reach Inkling at …"** Check the URL in the token is reachable *from the
Outbox host*. `localhost` in a container is not your laptop.

**"This API key is restricted to only send emails."** The plugin's status and targets
screens need a full-access key. Re-run `connect` without `--send-only`.

**"No verified sending domain yet."** Outbox refuses real sends from unverified domains.
See [Verify a domain](/tutorials/verify-a-domain). On the `console` transport this does
not apply, which is why the test send works before DNS does.

**Publishing sends nothing.** Check `broadcastOnPublish` is on, the entry's type is in
`broadcastTypes`, and a segment is set. The Inkling log records why it skipped.
