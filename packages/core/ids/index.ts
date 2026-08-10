import { randomBytes, randomUUID } from "node:crypto"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export const uuid = (): string => randomUUID()

const base62 = (byteLength: number): string => {
  const bytes = randomBytes(byteLength)
  let out = ""
  for (const b of bytes) out += BASE62[b % 62]
  return out
}

// Webhook event ids are Svix-shaped so existing tooling recognises them.
export const messageId = (): string => `msg_${base62(26)}`

// API keys are shown once. We store only the SHA-256 hash plus a display prefix.
export const apiKeyToken = (): string => `ob_${base62(32)}`

export const tokenPrefix = (token: string): string => `${token.slice(0, 8)}...`

export const secret = (bytes = 32): string => randomBytes(bytes).toString("base64url")

// Webhook signing secrets follow the Svix `whsec_<base64>` convention so the
// standard Svix verification libraries validate Outbox signatures unchanged.
export const signingSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`

// RFC 5322 Message-ID, scoped to the sending domain.
export const rfcMessageId = (domain: string): string =>
  `<${randomUUID()}@${domain.replace(/^@/, "")}>`

export const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `team-${base62(6).toLowerCase()}`
