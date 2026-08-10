import { describe, expect, test } from "bun:test"
import { hashToken } from "../auth/index.ts"
import { isEventType, signatureHeaders, signPayload, verifySignature } from "../events/index.ts"
import {
  apiKeyToken,
  messageId,
  rfcMessageId,
  signingSecret,
  slug,
  tokenPrefix,
} from "../ids/index.ts"

const SECRET = signingSecret()

describe("event types", () => {
  test("accepts documented types", () => {
    expect(isEventType("email.delivered")).toBe(true)
    expect(isEventType("contact.created")).toBe(true)
  })

  test("rejects unknown types", () => {
    expect(isEventType("email.exploded")).toBe(false)
  })
})

describe("webhook signing", () => {
  const id = messageId()
  const body = JSON.stringify({ type: "email.sent", data: { email_id: "abc" } })

  test("emits both svix- and webhook- header families", () => {
    const headers = signatureHeaders(SECRET, id, body)
    expect(headers["svix-id"]).toBe(id)
    expect(headers["webhook-id"]).toBe(id)
    expect(headers["svix-signature"]).toBe(headers["webhook-signature"]!)
  })

  test("signature is versioned v1", () => {
    expect(signPayload(SECRET, id, 1700000000, body)).toMatch(/^v1,[A-Za-z0-9+/=]+$/)
  })

  test("verifies a freshly signed payload", () => {
    const headers = signatureHeaders(SECRET, id, body)
    expect(
      verifySignature({
        signingSecret: SECRET,
        id,
        timestamp: headers["svix-timestamp"]!,
        signature: headers["svix-signature"]!,
        body,
      }),
    ).toBe(true)
  })

  test("rejects a tampered body", () => {
    const headers = signatureHeaders(SECRET, id, body)
    expect(
      verifySignature({
        signingSecret: SECRET,
        id,
        timestamp: headers["svix-timestamp"]!,
        signature: headers["svix-signature"]!,
        body: `${body} `,
      }),
    ).toBe(false)
  })

  test("rejects a different secret", () => {
    const headers = signatureHeaders(SECRET, id, body)
    expect(
      verifySignature({
        signingSecret: signingSecret(),
        id,
        timestamp: headers["svix-timestamp"]!,
        signature: headers["svix-signature"]!,
        body,
      }),
    ).toBe(false)
  })

  test("rejects a timestamp outside the tolerance window", () => {
    const old = Math.floor(Date.now() / 1000) - 3600
    expect(
      verifySignature({
        signingSecret: SECRET,
        id,
        timestamp: String(old),
        signature: signPayload(SECRET, id, old, body),
        body,
      }),
    ).toBe(false)
  })

  test("accepts a header carrying several versioned signatures", () => {
    const headers = signatureHeaders(SECRET, id, body)
    expect(
      verifySignature({
        signingSecret: SECRET,
        id,
        timestamp: headers["svix-timestamp"]!,
        signature: `v1,bogus ${headers["svix-signature"]}`,
        body,
      }),
    ).toBe(true)
  })
})

describe("ids", () => {
  test("webhook event ids are msg_-prefixed", () => {
    expect(messageId()).toMatch(/^msg_[0-9A-Za-z]{26}$/)
  })

  test("api keys are ob_-prefixed and unique", () => {
    const a = apiKeyToken()
    const b = apiKeyToken()
    expect(a).toMatch(/^ob_[0-9A-Za-z]{32}$/)
    expect(a).not.toBe(b)
  })

  test("token prefix keeps only the leading characters", () => {
    expect(tokenPrefix("ob_abcdefghijkl")).toBe("ob_abcde...")
  })

  test("signing secrets are whsec_-prefixed base64", () => {
    expect(signingSecret()).toMatch(/^whsec_[A-Za-z0-9+/=]+$/)
  })

  test("rfc message ids are angle-bracketed and domain-scoped", () => {
    expect(rfcMessageId("acme.com")).toMatch(/^<[0-9a-f-]{36}@acme\.com>$/)
  })

  test("slug strips punctuation and lowercases", () => {
    expect(slug("Acme, Inc.")).toBe("acme-inc")
  })

  test("slug falls back when the input has no usable characters", () => {
    expect(slug("!!!")).toMatch(/^team-/)
  })
})

describe("api key hashing", () => {
  test("is deterministic", () => {
    expect(hashToken("ob_test")).toBe(hashToken("ob_test"))
  })

  test("differs per token and never returns the plaintext", () => {
    const token = apiKeyToken()
    const hashed = hashToken(token)
    expect(hashed).not.toBe(token)
    expect(hashed).toHaveLength(64)
    expect(hashed).not.toBe(hashToken(apiKeyToken()))
  })
})
