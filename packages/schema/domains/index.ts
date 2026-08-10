import { column, defineSchema, type RowOf } from "@wess/atlas/db"

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// status: not_started | pending | verified | failed | temporary_failure
// tls: opportunistic | enforced
export const domains = defineSchema("domains", {
  id: id(),
  team_id: column.uuid().ref("teams", "id"),
  name: column.text(),
  status: column.text().default("not_started"),
  region: column.text().default("us-east-1"),
  open_tracking: column.boolean().default(false),
  click_tracking: column.boolean().default(false),
  tracking_subdomain: column.text().default("links"),
  tls: column.text().default("opportunistic"),
  custom_return_path: column.text().default("send"),
  sending: column.text().default("enabled"),
  receiving: column.text().default("disabled"),
  dkim_selector: column.text().default("outbox"),
  dkim_private_key: column.text().nullable(),
  dkim_public_key: column.text().nullable(),
  verified_at: column.timestamp().nullable(),
  last_checked_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

// record: SPF | DKIM | DMARC | MX | Tracking
export const domainRecords = defineSchema("domain_records", {
  id: id(),
  domain_id: column.uuid().ref("domains", "id"),
  record: column.text(),
  name: column.text(),
  type: column.text(),
  value: column.text(),
  ttl: column.text().default("Auto"),
  priority: column.integer().nullable(),
  status: column.text().default("not_started"),
  created_at: now(),
})

export type Domain = RowOf<typeof domains>
export type DomainRecord = RowOf<typeof domainRecords>
