import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

export const contacts = defineSchema("contacts", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  email: column.text(),
  first_name: column.text().nullable(),
  last_name: column.text().nullable(),
  unsubscribed: column.boolean().default(false),
  unsubscribed_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

// type: string | number
export const contactProperties = defineSchema("contact_properties", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  key: column.text(),
  type: column.text().default("string"),
  fallback_value: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

export const contactPropertyValues = defineSchema("contact_property_values", {
  id: id(),
  contact_id: column.uuid().ref("contacts", "id"),
  property_id: column.uuid().ref("contact_properties", "id"),
  value: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

export const segments = defineSchema("segments", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  created_at: now(),
  updated_at: now(),
})

export const segmentContacts = defineSchema("segment_contacts", {
  id: id(),
  segment_id: column.uuid().ref("segments", "id"),
  contact_id: column.uuid().ref("contacts", "id"),
  created_at: now(),
})

// default_subscription: opt_in | opt_out    visibility: public | private
export const topics = defineSchema("topics", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  description: column.text().nullable(),
  default_subscription: column.text().default("opt_in"),
  visibility: column.text().default("public"),
  created_at: now(),
  updated_at: now(),
})

// subscription: opt_in | opt_out
export const contactTopics = defineSchema("contact_topics", {
  id: id(),
  contact_id: column.uuid().ref("contacts", "id"),
  topic_id: column.uuid().ref("topics", "id"),
  subscription: column.text(),
  created_at: now(),
  updated_at: now(),
})

// origin: bounce | complaint | manual
export const suppressions = defineSchema("suppressions", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  email: column.text(),
  origin: column.text().default("manual"),
  source_id: column.uuid().nullable(),
  reason: column.text().nullable(),
  created_at: now(),
})

export type Contact = RowOf<typeof contacts>
export type ContactProperty = RowOf<typeof contactProperties>
export type ContactPropertyValue = RowOf<typeof contactPropertyValues>
export type Segment = RowOf<typeof segments>
export type SegmentContact = RowOf<typeof segmentContacts>
export type Topic = RowOf<typeof topics>
export type ContactTopic = RowOf<typeof contactTopics>
export type Suppression = RowOf<typeof suppressions>
