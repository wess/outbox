import { describe, expect, test } from "bun:test"
import { createHash, createVerify } from "node:crypto"
import {
  canonicalizeBodyRelaxed,
  canonicalizeHeaderRelaxed,
  dkimRecordValue,
  generateDkimKeys,
  signDkim,
} from "../dkim/index.ts"
import { buildMime } from "../mime/index.ts"

const CRLF = "\r\n"
const keys = generateDkimKeys(1024)

// Mirrors what a receiving MTA does with the DKIM-Signature header.
const verifySignature = (signed: string, publicKey: string): boolean => {
  const end = signed.indexOf(`${CRLF}From:`)
  const sigHeader = signed.slice(0, end)
  const tags = Object.fromEntries(
    sigHeader
      .slice("DKIM-Signature: ".length)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => {
        const i = t.indexOf("=")
        return [t.slice(0, i), t.slice(i + 1).replace(/\s+/g, "")]
      }),
  ) as Record<string, string>

  const rest = signed.slice(end + 2)
  const split = rest.indexOf(`${CRLF}${CRLF}`)
  const headers = rest
    .slice(0, split)
    .split(CRLF)
    .reduce<string[]>((acc, line) => {
      if (/^[ \t]/.test(line) && acc.length) acc[acc.length - 1] += CRLF + line
      else acc.push(line)
      return acc
    }, [])
  const body = rest.slice(split + 4)

  if (
    createHash("sha256").update(canonicalizeBodyRelaxed(body), "utf8").digest("base64") !== tags.bh
  ) {
    return false
  }

  const selected = (tags.h ?? "")
    .split(":")
    .map((name) => headers.find((h) => h.slice(0, h.indexOf(":")).trim().toLowerCase() === name))
    .filter((h): h is string => Boolean(h))

  const unsigned = sigHeader.replace(/b=[^;]*$/, "b=").replace(/\r\n\s*/g, "")
  const canonical = [
    ...selected.map(canonicalizeHeaderRelaxed),
    canonicalizeHeaderRelaxed(unsigned),
  ].join(CRLF)

  const verifier = createVerify("RSA-SHA256")
  verifier.update(canonical, "utf8")
  return verifier.verify(publicKey, tags.b ?? "", "base64")
}

const message = (overrides: Record<string, unknown> = {}) =>
  buildMime({
    from: "Acme <hi@acme.com>",
    to: ["user@example.com"],
    subject: "Test message",
    html: "<p>Hello</p>",
    messageId: "<abc@acme.com>",
    date: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  }).raw

describe("canonicalization", () => {
  test("relaxed headers lowercase the name and collapse whitespace", () => {
    expect(canonicalizeHeaderRelaxed("Subject:  Hello   World  ")).toBe("subject:Hello World")
  })

  test("relaxed headers unfold continuation lines", () => {
    expect(canonicalizeHeaderRelaxed(`Subject: a${CRLF}  b`)).toBe("subject:a b")
  })

  test("relaxed body strips trailing whitespace and empty trailing lines", () => {
    expect(canonicalizeBodyRelaxed(`a  ${CRLF}${CRLF}${CRLF}`)).toBe(`a${CRLF}`)
  })

  test("an empty body canonicalizes to an empty string", () => {
    expect(canonicalizeBodyRelaxed(`${CRLF}${CRLF}`)).toBe("")
  })
})

describe("signDkim", () => {
  test("produces a signature that verifies against the public key", () => {
    const signed = signDkim(message(), {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(verifySignature(signed, keys.publicKey)).toBe(true)
  })

  test("prepends the DKIM-Signature header", () => {
    const signed = signDkim(message(), {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(signed.startsWith("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;")).toBe(true)
  })

  test("fails verification when the body is tampered with", () => {
    const signed = signDkim(message(), {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(verifySignature(signed.replace("Hello", "Goodbye"), keys.publicKey)).toBe(false)
  })

  test("fails verification against a different key", () => {
    const other = generateDkimKeys(1024)
    const signed = signDkim(message(), {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(verifySignature(signed, other.publicKey)).toBe(false)
  })

  test("signs a message carrying attachments", () => {
    const raw = message({
      attachments: [{ filename: "a.txt", content: Buffer.from("data"), contentType: "text/plain" }],
    })
    const signed = signDkim(raw, {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(verifySignature(signed, keys.publicKey)).toBe(true)
  })

  test("signs a message with a non-ASCII subject", () => {
    const raw = message({ subject: "Héllo — wörld ✨" })
    const signed = signDkim(raw, {
      domain: "acme.com",
      selector: "outbox",
      privateKey: keys.privateKey,
    })
    expect(verifySignature(signed, keys.publicKey)).toBe(true)
  })
})

describe("dkimRecordValue", () => {
  test("emits a v=DKIM1 record", () => {
    expect(dkimRecordValue(keys.publicKey)).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/)
  })

  test("a 1024-bit key fits in a single DNS string", () => {
    expect(dkimRecordValue(keys.publicKey).length).toBeLessThan(255)
  })
})
