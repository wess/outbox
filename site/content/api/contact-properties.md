---
title: Contact properties
description: Define typed custom fields on contacts for use as template variables.
section: API reference
order: 17
---

# Contact properties

Contact properties are the custom fields you can store on a contact and reference in
templates and broadcasts. They are declared up front, so a typo in a send is an error
rather than a blank in someone's inbox.

## Create a property

```
POST /contact-properties
```

| Field | Type | Notes |
|---|---|---|
| `key` | `string` | **Required.** Letters, numbers, and underscores; must not start with a digit |
| `type` | `string` | **Required.** `string` or `number` |
| `fallback_value` | `string \| number` | Used when a contact has no value |

```sh
curl -X POST https://outbox.example.com/contact-properties \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "key": "company_name", "type": "string", "fallback_value": "your company" }'
```

```json
{ "object": "contact_property", "id": "f30e04c9-2dd5-4fb4-a6eb-fbed047d3416" }
```

The fallback is what makes personalisation safe. `Hi {{{first_name}}} at
{{{company_name}}}` renders sensibly even for contacts imported without a company.

## Retrieve a property

```
GET /contact-properties/:contact_property_id
```

```json
{
  "object": "contact_property",
  "id": "f30e04c9-2dd5-4fb4-a6eb-fbed047d3416",
  "key": "company_name",
  "type": "string",
  "fallback_value": "your company",
  "created_at": "2026-10-06 23:47:56.678+00",
  "updated_at": "2026-10-06 23:47:56.678+00"
}
```

Properties typed `number` return their fallback as a number, not a string.

## List properties

```
GET /contact-properties
```

Pagination is optional.

## Update a property

```
PATCH /contact-properties/:contact_property_id
```

```json
{ "fallback_value": "Acme Corp" }
```

Only `fallback_value` is mutable. `key` and `type` are fixed — changing either would
invalidate values already stored against it and silently break templates.

## Delete a property

```
DELETE /contact-properties/:contact_property_id
```

Deletes the definition and every contact's value for it. Templates referencing it will
render empty.

## Setting values

Values are set on the contact, not on the property:

```sh
curl -X PATCH https://outbox.example.com/contacts/steve@example.com \
  -H "Authorization: Bearer ob_xxxxxxxxx" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "properties": { "company_name": "Apple", "seat_count": 42 } }'
```

A key with no matching property is rejected:

```json
{
  "statusCode": 400,
  "name": "invalid_parameter",
  "message": "Unknown contact property `seat_cnt`. Create it first at /contact-properties."
}
```

A `number` property given a non-numeric value is rejected the same way.

## Using them in content

Properties are available by bare name, and contact fields under `contact.`:

```html
<p>Hi {{{contact.first_name|there}}},</p>
<p>{{{company_name}}} is on the {{{plan|free}}} plan with {{{seat_count}}} seats.</p>
```

Resolution order for each placeholder:

1. The contact's own value.
2. The inline fallback after `|`.
3. The property's `fallback_value`.
4. Empty string.

See [Templates](/api/templates) for the full syntax.
