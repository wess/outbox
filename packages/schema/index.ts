export * from "./accounts/index.ts"
export * from "./audience/index.ts"
export * from "./automations/index.ts"
export * from "./broadcasts/index.ts"
export * from "./domains/index.ts"
export * from "./emails/index.ts"
export * from "./integrations/index.ts"
export * from "./ops/index.ts"
export * from "./templates/index.ts"
export * from "./webhooks/index.ts"

import * as accounts from "./accounts/index.ts"
import * as audience from "./audience/index.ts"
import * as automations from "./automations/index.ts"
import * as broadcasts from "./broadcasts/index.ts"
import * as domains from "./domains/index.ts"
import * as emails from "./emails/index.ts"
import * as integrationsSchema from "./integrations/index.ts"
import * as ops from "./ops/index.ts"
import * as templates from "./templates/index.ts"
import * as webhooks from "./webhooks/index.ts"

const isSchema = (v: unknown): v is { table: string; columns: Record<string, unknown> } =>
  typeof v === "object" && v !== null && "table" in v && "columns" in v

// Every defineSchema() in the app, for migrate.diff and introspection.
export const allSchemas = [
  accounts,
  audience,
  automations,
  broadcasts,
  domains,
  emails,
  integrationsSchema,
  ops,
  templates,
  webhooks,
].flatMap((mod) => Object.values(mod).filter(isSchema))
