---
title: Transactional email with templates
description: Move email content out of your codebase and into versioned, publishable templates.
section: Tutorials
order: 33
---

# Transactional email with templates

Hard-coded HTML in your application means every copy change is a deploy, and marketing
cannot touch it without a pull request. Templates fix both.

## 1. Create one

```sh
curl -X POST https://outbox.example.com/templates \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Password reset",
    "alias": "password-reset",
    "from": "Acme <security@acme.com>",
    "subject": "Reset your password",
    "html": "<p>Hi {{{first_name|there}}},</p><p><a href=\"{{{reset_url}}}\">Reset your password</a></p><p>This link expires in {{{expiry_minutes}}} minutes. If you did not request it, ignore this email.</p>",
    "text": "Hi {{{first_name|there}}},\n\nReset your password: {{{reset_url}}}\n\nExpires in {{{expiry_minutes}}} minutes.",
    "variables": [
      { "key": "first_name", "type": "string", "fallback_value": "there" },
      { "key": "reset_url", "type": "string" },
      { "key": "expiry_minutes", "type": "number", "fallback_value": 30 }
    ]
  }'
```

Set an **alias**. Sending to `password-reset` rather than a UUID means your code does not
change when the template is recreated.

## 2. Publish it

A new template is a draft and cannot be sent:

```sh
curl -X POST https://outbox.example.com/templates/password-reset/publish \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

## 3. Send it

```ts
await resend.emails.send({
  to: [user.email],
  template: {
    id: "password-reset",
    variables: {
      first_name: user.firstName,
      reset_url: `https://acme.com/reset?token=${token}`,
      expiry_minutes: 30,
    },
  },
})
```

No `from`, no `subject`, no HTML — they come from the template. Override any of them by
passing it explicitly.

## 4. Edit safely

Any content change creates a **new draft version**. Production keeps using the published
one until you publish again:

```sh
curl -X PATCH https://outbox.example.com/templates/password-reset \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "Reset your Acme password" }'
```

`has_unpublished_versions` becomes `true`. Nothing changes for senders until:

```sh
curl -X POST https://outbox.example.com/templates/password-reset/publish \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

This is the property that makes templates safe to hand to someone else: a mistake in the
editor cannot reach customers until someone publishes it.

## Variables

| Form | Behaviour |
|---|---|
| `{{{key}}}` | Raw insertion |
| `{{{key\|fallback}}}` | Fallback when missing or empty |
| `{{key}}` | HTML-escaped |
| `{{{contact.first_name}}}` | Contact fields, when sending to a contact |
| `{{{OUTBOX_UNSUBSCRIBE_URL}}}` | Signed per-recipient unsubscribe link |

Resolution: supplied value → inline fallback → declared `fallback_value` → empty.

**Escape anything a user typed.** `{{{name}}}` with a name of `<script>` inserts a
script tag. Use `{{name}}` for user-supplied values and reserve triple braces for HTML
you control and for URLs.

## Structuring a set

A workable convention:

| Alias | Purpose |
|---|---|
| `welcome` | After signup |
| `password-reset` | Reset link |
| `email-verification` | Confirm address |
| `invoice-receipt` | Payment succeeded |
| `payment-failed` | Payment retry needed |
| `trial-ending` | Three days left |

Then a thin wrapper so call sites stay honest:

```ts
type TemplateId =
  | "welcome"
  | "password-reset"
  | "email-verification"
  | "invoice-receipt"
  | "payment-failed"
  | "trial-ending"

export const sendTemplate = async (
  to: string,
  id: TemplateId,
  variables: Record<string, string | number>,
) => {
  const { data, error } = await resend.emails.send({ to: [to], template: { id, variables } })
  if (error) {
    console.error(`template ${id} failed for ${to}`, error)
    return null
  }
  return data.id
}
```

```ts
await sendTemplate(user.email, "password-reset", {
  first_name: user.firstName,
  reset_url: resetUrl,
  expiry_minutes: 30,
})
```

## Unsubscribe links in transactional mail

Receipts and password resets do not need one. Anything with a whiff of marketing does —
"here's what's new", "you haven't logged in lately" — even when it is technically
transactional.

Add a [topic](/api/topics) and the placeholder, and recipients can opt out of that
category without losing their receipts:

```json
{
  "template": { "id": "product-digest" },
  "topic_id": "b6d24b8e-af0b-4c3c-be0c-359bbd97381e"
}
```

## Previewing

The dashboard renders a live preview of the published version. To check variable
substitution end to end, send to yourself with the `console` transport and read the
rendered MIME in the worker log — that is the exact bytes a recipient would get.
