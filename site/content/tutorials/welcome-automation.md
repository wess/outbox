---
title: Build a welcome automation
description: A branching, multi-day onboarding sequence triggered by an event from your app.
section: Tutorials
order: 35
---

# Build a welcome automation

We will build an onboarding sequence that branches on the user's plan, waits a day, and
gives up early if they do the thing we wanted them to do.

## The shape

```
user.created
     │
     ├── plan = pro ──→ send pro welcome ──→ wait 1 day ──→ wait for project.created (3d)
     │                                                            │
     │                                                            └── timeout → send "need a hand?"
     │
     └── otherwise ──→ send free welcome ──→ wait 3 days ──→ send upgrade nudge
```

## 1. Templates first

```sh
for t in pro-welcome free-welcome need-a-hand upgrade-nudge; do
  curl -X POST https://outbox.example.com/templates \
    -H "Authorization: Bearer $OUTBOX_API_KEY" \
    -H "User-Agent: my-app/1.0" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"$t\",
      \"alias\": \"$t\",
      \"from\": \"Acme <hello@mail.acme.com>\",
      \"subject\": \"Welcome to Acme\",
      \"html\": \"<p>Hi {{{contact.first_name|there}}}!</p>\"
    }"
  curl -X POST https://outbox.example.com/templates/$t/publish \
    -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
done
```

Remember to publish — an unpublished template cannot be sent, and inside an automation
that failure is easy to miss.

## 2. The automation

```sh
curl -X POST https://outbox.example.com/automations \
  -H "Authorization: Bearer $OUTBOX_API_KEY" \
  -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Onboarding",
    "status": "disabled",
    "steps": [
      { "key": "start", "type": "trigger", "config": { "event_name": "user.created" } },
      {
        "key": "is_pro",
        "type": "condition",
        "config": { "type": "rule", "field": "event.plan", "operator": "eq", "value": "pro" }
      },
      { "key": "pro_welcome", "type": "send_email", "config": { "template_id": "pro-welcome" } },
      { "key": "day_one", "type": "delay", "config": { "duration": 1, "unit": "days" } },
      {
        "key": "await_project",
        "type": "wait_for_event",
        "config": { "event_name": "project.created", "duration": 3, "unit": "days" }
      },
      { "key": "need_a_hand", "type": "send_email", "config": { "template_id": "need-a-hand" } },
      { "key": "free_welcome", "type": "send_email", "config": { "template_id": "free-welcome" } },
      { "key": "day_three", "type": "delay", "config": { "duration": 3, "unit": "days" } },
      { "key": "upgrade_nudge", "type": "send_email", "config": { "template_id": "upgrade-nudge" } }
    ],
    "edges": [
      { "from": "start", "to": "is_pro", "type": "default" },
      { "from": "is_pro", "to": "pro_welcome", "type": "condition_met" },
      { "from": "pro_welcome", "to": "day_one", "type": "default" },
      { "from": "day_one", "to": "await_project", "type": "default" },
      { "from": "await_project", "to": "need_a_hand", "type": "default" },
      { "from": "is_pro", "to": "free_welcome", "type": "condition_not_met" },
      { "from": "free_welcome", "to": "day_three", "type": "default" },
      { "from": "day_three", "to": "upgrade_nudge", "type": "default" }
    ]
  }'
```

Note `"status": "disabled"`. Create it disabled, check the graph, then enable — an
automation that starts running the moment you create it is hard to un-send.

## 3. Trigger it

```ts
await fetch(`${BASE}/events/send`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: "user.created",
    email: user.email,
    data: { plan: user.plan, signup_source: user.source },
  }),
})
```

Anything in `data` is available to conditions as `event.*` and to templates.

Call this **after** the user is committed to your database, not before. An automation
that welcomes someone whose signup then failed is worse than a slightly delayed welcome.

## 4. Test both branches

```sh
curl -X POST https://outbox.example.com/events/send \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "user.created", "email": "pro-test@example.com", "data": { "plan": "pro" } }'

curl -X POST https://outbox.example.com/events/send \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "name": "user.created", "email": "free-test@example.com", "data": { "plan": "free" } }'
```

Then inspect:

```sh
curl https://outbox.example.com/automations/$AUTOMATION_ID/runs \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0"
```

```json
{
  "data": [
    { "id": "…", "email": "pro-test@example.com", "status": "waiting", "current_step_key": "day_one" },
    { "id": "…", "email": "free-test@example.com", "status": "waiting", "current_step_key": "day_three" }
  ]
}
```

Fetch a single run to see exactly which branch was taken:

```json
{
  "steps": [
    { "key": "start", "type": "trigger", "status": "completed" },
    { "key": "is_pro", "type": "condition", "status": "completed", "result": { "met": true } },
    { "key": "pro_welcome", "type": "send_email", "status": "completed", "result": { "email_id": "…" } },
    { "key": "day_one", "type": "delay", "status": "completed", "result": { "resume_at": "…" } }
  ]
}
```

Shorten the delays to seconds while testing, then change them back.

## 5. Enable it

```sh
curl -X PATCH https://outbox.example.com/automations/$AUTOMATION_ID \
  -H "Authorization: Bearer $OUTBOX_API_KEY" -H "User-Agent: my-app/1.0" \
  -H "Content-Type: application/json" \
  -d '{ "status": "enabled" }'
```

## How waiting works

`delay` and `wait_for_event` suspend the run rather than holding a worker. A 30-day
sequence costs nothing while it waits, and thousands of concurrent runs need no extra
capacity.

`wait_for_event` resumes when a matching event arrives for the same contact. If the
timeout passes first, the run **completes** rather than continuing — which is why
`await_project` flows to `need_a_hand` only on timeout. Someone who created a project
does not need the nudge, and that is exactly the behaviour you want.

## Conditions worth knowing

```json
{
  "type": "and",
  "rules": [
    { "field": "event.plan", "operator": "eq", "value": "pro" },
    { "field": "event.seats", "operator": "gte", "value": 5 },
    { "field": "contact.first_name", "operator": "exists" }
  ]
}
```

Fields resolve against `event.*`, `contact.*`, and contact properties by name. Operators:
`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `exists`, `not_exists`.

## Practical notes

**One run per event.** Sending `user.created` twice starts two runs and sends two welcome
emails. Deduplicate on your side, or trigger from a state change you know happens once.

**A missing branch ends the run.** A condition with no `condition_not_met` edge simply
finishes for contacts that fail it. That is often what you want; make sure it is.

**Failures stop the run.** A failed step marks the run `failed` with the error recorded.
Check runs after changing templates — an unpublished template is the usual cause.

**Give steps meaningful keys.** `day_one` reads better than `step_4` when you are staring
at a run three months from now.
