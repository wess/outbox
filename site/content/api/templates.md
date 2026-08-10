---
title: Templates
description: Versioned email content with typed variables and a draft/publish workflow.
section: API reference
order: 19
---

# Templates

Templates keep email content out of your codebase. Each edit creates a new version;
publishing promotes one to current. Sends always use the published version, so editing a
template cannot break production mid-flight.

## Create a template

```
POST /templates
```

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | **Required** |
| `html` | `string` | **Required** |
| `alias` | `string` | Stable id you can send to instead of the UUID |
| `from` | `string` | Default sender |
| `subject` | `string` | Supports variables |
| `text` | `string` | |
| `reply_to` | `string \| string[]` | |
| `variables` | `array` | `{ key, type, fallback_value }`, max 50 |

```sh
curl -X POST https://outbox.example.com/templates \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-confirmation",
    "alias": "order-confirmation",
    "from": "Acme <orders@acme.com>",
    "subject": "Your order of {{{PRODUCT}}}",
    "html": "<p>Thanks! {{{PRODUCT}}} costs {{{PRICE}}}.</p>",
    "variables": [
      { "key": "PRODUCT", "type": "string", "fallback_value": "item" },
      { "key": "PRICE", "type": "number", "fallback_value": 0 }
    ]
  }'
```

```json
{ "object": "template", "id": "34a080c9-b17d-4187-ad80-5af20266e535" }
```

A newly created template is a **draft**. It cannot be sent until published.

## Variable syntax

```html
<p>Hi {{{first_name|there}}},</p>
<p>Your {{{PRODUCT}}} ships {{{ship_date}}}.</p>
<p><a href="{{{OUTBOX_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p>
```

| Form | Behaviour |
|---|---|
| `{{{KEY}}}` | Inserts raw |
| `{{{KEY\|fallback}}}` | Inserts, or the fallback when missing or empty |
| `{{KEY}}` | Inserts HTML-escaped |
| `{{{contact.first_name}}}` | Dotted paths into the render context |
| `{{{OUTBOX_UNSUBSCRIBE_URL}}}` | Replaced with a signed per-recipient URL |

Resolution order: the supplied value, then the inline fallback, then the declared
variable's `fallback_value`, then empty.

Use double braces for anything a user typed. Triple braces do not escape, which is
correct for HTML fragments and wrong for a display name.

## Publish

```
POST /templates/:id/publish
```

Promotes the latest version to current and sets status to `published`.

```json
{
  "object": "template",
  "id": "34a080c9-b17d-4187-ad80-5af20266e535",
  "current_version_id": "b2693018-7abb-4b4b-b4cb-aadf72dc06bd"
}
```

Sending with an unpublished template returns:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "Template has no published version. Publish it before sending."
}
```

## Retrieve a template

```
GET /templates/:id
```

`:id` accepts the template id or its alias.

```json
{
  "object": "template",
  "id": "34a080c9-b17d-4187-ad80-5af20266e535",
  "current_version_id": "b2693018-7abb-4b4b-b4cb-aadf72dc06bd",
  "alias": "order-confirmation",
  "name": "order-confirmation",
  "created_at": "2026-10-06 23:47:56.678+00",
  "updated_at": "2026-10-06 23:47:56.678+00",
  "status": "published",
  "published_at": "2026-10-06 23:47:56.678+00",
  "from": "Acme <orders@acme.com>",
  "subject": "Your order of {{{PRODUCT}}}",
  "reply_to": null,
  "html": "<p>Thanks! {{{PRODUCT}}} costs {{{PRICE}}}.</p>",
  "text": null,
  "variables": [
    {
      "id": "e169aa45-1ecf-4183-9955-b1499d5701d3",
      "key": "PRODUCT",
      "type": "string",
      "fallback_value": "item",
      "created_at": "2026-10-06 23:47:56.678+00",
      "updated_at": "2026-10-06 23:47:56.678+00"
    }
  ],
  "has_unpublished_versions": false
}
```

`has_unpublished_versions` tells you an edit is waiting — useful for a "publish changes"
badge in your own tooling.

## List templates

```
GET /templates
```

Always paginated.

## Update a template

```
PATCH /templates/:id
```

`name` and `alias` change in place. Any content change — `html`, `text`, `subject`,
`from`, `reply_to`, `variables` — creates a **new draft version**. Live sends keep using
the published version until you publish again.

## Duplicate

```
POST /templates/:id/duplicate
```

Copies the current content and variables into a new template named `<name> (copy)` with
no alias.

## Delete

```
DELETE /templates/:id
```

Deletes the template and all its versions. Emails already sent keep their content.

## Sending with a template

```json
{
  "to": ["buyer@example.com"],
  "template": {
    "id": "order-confirmation",
    "variables": { "PRODUCT": "Widget", "PRICE": 42 }
  }
}
```

`from` and `subject` come from the template when you do not override them, so a send can
be as small as a recipient and a variable bag. Anything you pass explicitly wins.
