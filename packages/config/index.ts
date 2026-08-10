import { defineConfig, env } from "@wess/atlas/config"

const bool = (v: string) => v === "true" || v === "1" || v === "yes"

export const config = defineConfig({
  databaseUrl: env("DATABASE_URL", {
    default: "postgres://outbox:outbox@localhost:55432/outbox",
  }),
  dbPool: env("DB_POOL_SIZE", { parse: Number, default: "10" }),
  jwtSecret: env("JWT_SECRET", { default: "outbox-dev-secret-change-me" }),
  port: env("PORT", { parse: Number, default: "3000" }),
  publicUrl: env("PUBLIC_URL", { default: "http://localhost:3000" }),
  hostname: env("OUTBOX_HOSTNAME", { default: "localhost" }),

  transport: env("OUTBOX_TRANSPORT", { default: "console" }),
  relay: {
    host: env("SMTP_RELAY_HOST", { default: "" }),
    port: env("SMTP_RELAY_PORT", { parse: Number, default: "587" }),
    user: env("SMTP_RELAY_USER", { default: "" }),
    pass: env("SMTP_RELAY_PASS", { default: "" }),
    secure: env("SMTP_RELAY_SECURE", { default: "starttls" }),
  },

  inbound: {
    enabled: env("INBOUND_ENABLED", { parse: bool, default: "false" }),
    port: env("INBOUND_PORT", { parse: Number, default: "2525" }),
  },

  worker: {
    concurrency: env("WORKER_CONCURRENCY", { parse: Number, default: "8" }),
    pollMs: env("WORKER_POLL_MS", { parse: Number, default: "1000" }),
  },

  rateLimitPerSecond: env("RATE_LIMIT_PER_SECOND", { parse: Number, default: "10" }),
  maxAttachmentBytes: env("MAX_ATTACHMENT_BYTES", { parse: Number, default: "41943040" }),
  trustedProxies: env("TRUSTED_PROXIES", { default: "" }),
})

export type Config = typeof config
