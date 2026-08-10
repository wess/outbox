import { describe, expect, test } from "bun:test"
import {
  formatAddress,
  parseAddress,
  parseAddressList,
  splitAddressList,
} from "../addresses/index.ts"
import { buildMime, encodeWord, htmlToText, quotedPrintable, recipientsOf } from "../mime/index.ts"

const CRLF = "\r\n"

describe("addresses", () => {
  test("parses a bare address", () => {
    expect(parseAddress("user@example.com")).toEqual({ name: null, email: "user@example.com" })
  })

  test("parses a display name", () => {
    expect(parseAddress("Acme <hi@acme.com>")).toEqual({ name: "Acme", email: "hi@acme.com" })
  })

  test("parses a quoted display name containing a comma", () => {
    expect(parseAddress('"Wozniak, Steve" <s@apple.com>')).toEqual({
      name: "Wozniak, Steve",
      email: "s@apple.com",
    })
  })

  test("rejects malformed addresses", () => {
    for (const bad of ["not-an-email", "a@b", "@example.com", "a b@example.com", ""]) {
      expect(parseAddress(bad)).toBeNull()
    }
  })

  test("splits on commas outside quotes and angle brackets", () => {
    expect(splitAddressList('"Last, First" <a@x.com>, b@y.com')).toEqual([
      '"Last, First" <a@x.com>',
      "b@y.com",
    ])
  })

  test("round-trips a name needing quotes", () => {
    const addr = { name: "Wozniak, Steve", email: "s@apple.com" }
    expect(parseAddress(formatAddress(addr))).toEqual(addr)
  })

  test("parseAddressList flattens arrays and comma lists", () => {
    expect(parseAddressList(["a@x.com, b@x.com", "c@x.com"]).map((a) => a.email)).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ])
  })
})

describe("encodeWord", () => {
  test("leaves plain ASCII untouched", () => {
    expect(encodeWord("Hello world")).toBe("Hello world")
  })

  test("base64-encodes non-ASCII", () => {
    expect(encodeWord("Héllo")).toMatch(/^=\?UTF-8\?B\?.+\?=$/)
  })

  test("splits long values into multiple encoded words", () => {
    const encoded = encodeWord("é".repeat(200))
    expect(encoded.split("=?UTF-8?B?").length - 1).toBeGreaterThan(1)
  })
})

describe("quotedPrintable", () => {
  test("escapes the equals sign", () => {
    expect(quotedPrintable("a=b")).toBe("a=3Db")
  })

  test("encodes non-ASCII bytes", () => {
    expect(quotedPrintable("é")).toBe("=C3=A9")
  })

  test("encodes trailing whitespace so it survives transport", () => {
    expect(quotedPrintable("word ")).toBe("word=20")
  })

  test("keeps lines within 76 characters", () => {
    for (const line of quotedPrintable("x".repeat(500)).split(CRLF)) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
  })
})

describe("htmlToText", () => {
  test("keeps text and drops markup", () => {
    expect(htmlToText("<h1>Hi</h1><p>There</p>")).toBe("Hi\nThere")
  })

  test("drops script and style contents", () => {
    expect(htmlToText("<p>ok</p><script>alert(1)</script>")).toBe("ok")
  })

  test("decodes entities", () => {
    expect(htmlToText("<p>a &amp; b</p>")).toBe("a & b")
  })
})

describe("buildMime", () => {
  const base = {
    from: "Acme <hi@acme.com>",
    to: ["user@example.com"],
    subject: "Test",
    messageId: "<abc@acme.com>",
    date: new Date("2026-01-01T00:00:00Z"),
  }

  test("text-only builds a flat text/plain part", () => {
    const built = buildMime({ ...base, text: "hello" })
    expect(built.raw).toContain("Content-Type: text/plain; charset=utf-8")
    expect(built.raw).not.toContain("multipart")
  })

  test("html builds multipart/alternative with a derived text part", () => {
    const built = buildMime({ ...base, html: "<p>hello</p>" })
    expect(built.raw).toContain("multipart/alternative")
    expect(built.raw).toContain("text/plain")
    expect(built.raw).toContain("text/html")
  })

  test("attachments wrap the body in multipart/mixed", () => {
    const built = buildMime({
      ...base,
      html: "<p>hi</p>",
      attachments: [{ filename: "a.txt", content: Buffer.from("data"), contentType: "text/plain" }],
    })
    expect(built.raw).toContain("multipart/mixed")
    expect(built.raw).toContain('Content-Disposition: attachment; filename="a.txt"')
  })

  test("inline images use multipart/related and a Content-ID", () => {
    const built = buildMime({
      ...base,
      html: '<img src="cid:logo" />',
      attachments: [
        {
          filename: "logo.png",
          content: Buffer.from("x"),
          contentType: "image/png",
          contentId: "logo",
        },
      ],
    })
    expect(built.raw).toContain("multipart/related")
    expect(built.raw).toContain("Content-ID: <logo>")
    expect(built.raw).toContain("Content-Disposition: inline")
  })

  test("drops caller headers that would forge identity or routing", () => {
    const built = buildMime({
      ...base,
      text: "x",
      headers: { From: "evil@bad.com", "Message-ID": "<forged>", "X-Custom": "keep" },
    })
    expect(built.raw).not.toContain("evil@bad.com")
    expect(built.raw).not.toContain("<forged>")
    expect(built.raw).toContain("X-Custom: keep")
  })

  test("header injection through the subject cannot add headers", () => {
    const built = buildMime({ ...base, subject: "Hi\r\nBcc: victim@example.com", text: "x" })
    expect(built.raw).not.toMatch(/^Bcc:/m)
  })

  test("adds List-Unsubscribe and the one-click marker together", () => {
    const built = buildMime({
      ...base,
      text: "x",
      listUnsubscribe: "<https://example.com/u/abc>",
      listUnsubscribePost: true,
    })
    expect(built.raw).toContain("List-Unsubscribe: <https://example.com/u/abc>")
    expect(built.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click")
  })

  test("headers and body are separated by a blank line", () => {
    const built = buildMime({ ...base, text: "hello" })
    expect(built.raw).toContain(`${CRLF}${CRLF}`)
  })
})

describe("header injection", () => {
  const base = {
    from: "Acme <hi@acme.com>",
    to: ["user@example.com"],
    subject: "Test",
    messageId: "<abc@acme.com>",
    date: new Date("2026-01-01T00:00:00Z"),
  }

  test("CRLF in a display name cannot add a header", () => {
    const built = buildMime({ ...base, from: '"a\r\nBcc: victim@x.com" <hi@acme.com>', text: "x" })
    expect(built.raw).not.toMatch(/^Bcc:/m)
  })

  test("CRLF in a custom header value cannot add a header", () => {
    const built = buildMime({
      ...base,
      text: "x",
      headers: { "X-Ref": "1\r\nBcc: victim@x.com" },
    })
    expect(built.raw).not.toMatch(/^Bcc:/m)
  })

  test("a newline in a custom header name cannot add a header", () => {
    const built = buildMime({
      ...base,
      text: "x",
      headers: { "X-A\r\nBcc": "victim@x.com" },
    })
    expect(built.raw).not.toMatch(/^Bcc:/m)
  })

  test("encodeWord folds CRLF to a space and drops other control bytes", () => {
    expect(encodeWord("a\r\nb")).toBe("a b")
    expect(encodeWord("ab")).toBe("ab")
  })
})

describe("recipientsOf", () => {
  test("merges to/cc/bcc and de-duplicates", () => {
    expect(
      recipientsOf({
        to: ["A <a@x.com>", "b@x.com"],
        cc: ["b@x.com"],
        bcc: ["c@x.com"],
      }),
    ).toEqual(["a@x.com", "b@x.com", "c@x.com"])
  })
})
