---
title: Automations
description: Event-triggered workflows built as a step graph, with branching, delays, and waits.
section: API reference
order: 22
---

# Automations

An automation runs a sequence of steps whenever your application sends a matching event.
Welcome series, drip campaigns, trial expiry, abandoned cart — anything shaped as "when
X happens, do these things, maybe waiting in between".

## Model

An automation is a graph of **steps** connected by **edges**.

| Step type | Behaviour |
|---|---|
| `trigger` | Entry point. Exactly one per automation |
| `condition` | Branches on `condition_met` / `condition_not_met` edges |
| `delay` | Suspends the run, resumes after a duration |
| `wait_for_event` | Suspends until a named event arrives |
| `send_email` | Sends inline content or a template |
| `add_to_segment` | Adds the contact to a segment |
| `contact_update` | Updates contact fields |
| `contact_delete` | Deletes the contact |

Edges carry a `type` of `default`, `condition_met`, or `condition_not_met`.

## Create an automation

```
POST /automations
```

```json
{
  "name": "Welcome series",
  "status": "enabled",
  "steps": [
    { "key": "start", "type": "trigger", "config": { "event_name": "user.created" } },
    {
      "key": "check_plan",
      "type": "condition",
      "config": { "type": "rule", "field": "event.plan", "operator": "eq", "value": "pro" }
    },
    { "key": "wait", "type": "delay", "config": { "duration": 1, "unit": "days" } },
    { "key": "pro_welcome", "type": "send_email", "config": { "template_id": "pro-welcome" } },
    {
      "key": "free_welcome",
      "type": "send_email",
      "config": {
        "from": "Acme <hi@acme.com>",
        "subject": "Welcome to Acme",
        "html": "<p>Hi {{{contact.first_name|there}}}!</p>"
      }
    }
  ],
  "edges": [
    { "from": "start", "to": "check_plan", "type": "default" },
    { "from": "check_plan", "to": "wait", "type": "condition_met" },
    { "from": "wait", "to": "pro_welcome", "type": "default" },
    { "from": "check_plan", "to": "free_welcome", "type": "condition_not_met" }
  ]
}
```

Validation is strict, because a broken graph fails silently at 3am otherwise:

- Exactly one `trigger` step, and it must have `config.event_name`.
- Every edge must reference steps that exist.

## Conditions

```json
{
  "type": "rule",
  "field": "event.plan",
  "operator": "eq",
  "value": "pro"
}
```

Fields read from the run context: `event.*` for the event payload, `contact.*` for
contact fields, and contact properties by name.

| Operator | Meaning |
|---|---|
| `eq`, `neq` | Equality, numeric when both sides are numbers |
| `gt`, `gte`, `lt`, `lte` | Numeric comparison |
| `contains`, `not_contains` | Substring |
| `starts_with`, `ends_with` | Substring |
| `exists`, `not_exists` | Presence and non-emptiness |

Group rules with `and` / `or`:

```json
{
  "type": "and",
  "rules": [
    { "field": "event.plan", "operator": "eq", "value": "pro" },
    { "field": "event.seats", "operator": "gte", "value": 5 }
  ]
}
```

## Delays and waits

```json
{ "key": "wait", "type": "delay", "config": { "duration": 3, "unit": "days" } }
```

Units: `seconds`, `minutes`, `hours`, `days`, `weeks`. `{ "seconds": 90 }` also works.

```json
{
  "key": "await_purchase",
  "type": "wait_for_event",
  "config": { "event_name": "order.completed", "duration": 7, "unit": "days" }
}
```

Both suspend the run rather than holding a worker, so a 30-day sequence costs nothing
while it waits. A `wait_for_event` that times out completes the run rather than
continuing down the graph.

## Trigger a run

```
POST /events/send
```

```json
{
  "name": "user.created",
  "email": "new@example.com",
  "data": { "plan": "pro", "seats": 12 }
}
```

Pass `email` or `contact_id`. Anything in `data` is available to conditions and templates
as `event.*`.

```json
{ "object": "event", "id": "5f8c…", "name": "user.created" }
```

Every enabled automation whose trigger matches starts a run. The same call also resumes
any run parked on `wait_for_event` for that name.

## Inspect runs

```
GET /automations/:automation_id/runs
GET /automations/:automation_id/runs/:run_id
```

```json
{
  "object": "automation_run",
  "id": "b0f1…",
  "contact_id": "e169aa45-…",
  "email": "new@example.com",
  "status": "completed",
  "current_step_key": null,
  "context": { "event": { "plan": "pro" }, "event_name": "user.created" },
  "started_at": "2026-08-10 13:37:47.113+00",
  "completed_at": "2026-08-10 13:37:49.882+00",
  "error": null,
  "steps": [
    { "key": "start", "type": "trigger", "status": "completed", "error": null },
    { "key": "check_plan", "type": "condition", "status": "completed", "result": { "met": true } },
    { "key": "pro_welcome", "type": "send_email", "status": "completed", "result": { "email_id": "…" } }
  ]
}
```

Run statuses: `running`, `waiting`, `completed`, `failed`, `canceled`. The step list is
the debugging tool — it shows exactly which branch was taken and why.

## Custom events

```
GET  /automations/events
POST /automations/events
```

Registering an event name up front makes it available in the dashboard picker. Sending
an unregistered name still works and registers it automatically.

## Manage

```
GET    /automations
GET    /automations/:automation_id
PATCH  /automations/:automation_id
DELETE /automations/:automation_id
```

`PATCH` accepts `name`, `description`, `status`, and a full `steps`/`edges` replacement.
Supplying steps rewrites the whole graph.

New automations default to `disabled` — enable one deliberately, after checking the
graph, rather than discovering it live.

See [Build a welcome automation](/tutorials/welcome-automation) for a worked example.
