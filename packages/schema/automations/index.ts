import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// status: enabled | disabled
export const automations = defineSchema("automations", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  description: column.text().nullable(),
  status: column.text().default("disabled"),
  created_at: now(),
  updated_at: now(),
})

// type: trigger | condition | delay | wait_for_event | send_email
//     | add_to_segment | contact_update | contact_delete
// `key` is the caller-facing step name used by edges ("start", "check_plan", …).
export const automationSteps = defineSchema("automation_steps", {
  id: id(),
  automation_id: column.uuid().ref("automations", "id"),
  team_id: column.uuid(),
  key: column.text(),
  type: column.text(),
  config: column.json<Record<string, unknown>>().nullable(),
  position: column.integer().default(0),
  created_at: now(),
  updated_at: now(),
})

// type: default | condition_met | condition_not_met
export const automationEdges = defineSchema("automation_edges", {
  id: id(),
  automation_id: column.uuid().ref("automations", "id"),
  from_key: column.text(),
  to_key: column.text(),
  type: column.text().default("default"),
  created_at: now(),
})

// status: running | waiting | completed | failed | canceled
export const automationRuns = defineSchema("automation_runs", {
  id: id(),
  automation_id: column.uuid().ref("automations", "id"),
  team_id: column.uuid(),
  contact_id: column.uuid().nullable(),
  email: column.text().nullable(),
  status: column.text().default("running"),
  current_step_key: column.text().nullable(),
  resume_at: column.timestamp().nullable(),
  waiting_for_event: column.text().nullable(),
  context: column.json<Record<string, unknown>>().nullable(),
  error: column.text().nullable(),
  started_at: now(),
  completed_at: column.timestamp().nullable(),
})

// status: completed | skipped | failed
export const automationRunSteps = defineSchema("automation_run_steps", {
  id: id(),
  run_id: column.uuid().ref("automation_runs", "id"),
  step_key: column.text(),
  step_type: column.text(),
  status: column.text(),
  result: column.json<Record<string, unknown>>().nullable(),
  error: column.text().nullable(),
  created_at: now(),
})

// Registry of event names the team has declared, for dashboard autocomplete.
export const customEvents = defineSchema("custom_events", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  description: column.text().nullable(),
  created_at: now(),
})

// Every event.send call, kept for run debugging.
export const eventDeliveries = defineSchema("event_deliveries", {
  id: id(),
  team_id: column.uuid(),
  name: column.text(),
  email: column.text().nullable(),
  contact_id: column.uuid().nullable(),
  data: column.json<Record<string, unknown>>().nullable(),
  created_at: now(),
})

export type Automation = RowOf<typeof automations>
export type AutomationStep = RowOf<typeof automationSteps>
export type AutomationEdge = RowOf<typeof automationEdges>
export type AutomationRun = RowOf<typeof automationRuns>
export type AutomationRunStep = RowOf<typeof automationRunSteps>
export type CustomEvent = RowOf<typeof customEvents>
export type EventDelivery = RowOf<typeof eventDeliveries>
