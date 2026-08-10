import { describe, expect, test } from "bun:test"
import { decodeQuotedPrintable, decodeWords, parseHeaders, parseMessage } from "../parser/index.ts"

const CRLF = "\r\n"
const lines = (...parts: string[]) => parts.join(CRLF)

describe("decodeWords", () => {
  test("decodes base64 encoded-words", () => {
    expect(decodeWords("=?UTF-8?B?SMOpbGxv?=")).toBe("Héllo")
  })

  test("decodes quoted-printable encoded-words", () => {
    expect(decodeWords("=?UTF-8?Q?H=C3=A9llo?=")).toBe("Héllo")
  })

  test("treats underscore as a space in Q encoding", () => {
    expect(decodeWords("=?UTF-8?Q?a_b?=")).toBe("a b")
  })

  test("leaves plain text alone", () => {
    expect(decodeWords("Hello")).toBe("Hello")
  })
})

describe("decodeQuotedPrintable", () => {
  test("decodes hex escapes", () => {
    expect(decodeQuotedPrintable("=C3=A9").toString("utf8")).toBe("é")
  })

  test("removes soft line breaks", () => {
    expect(decodeQuotedPrintable(`abc=${CRLF}def`).toString("utf8")).toBe("abcdef")
  })
})

describe("parseHeaders", () => {
  test("lowercases names and unfolds continuations", () => {
    const headers = parseHeaders(lines("Subject: a", "  b", "From: x@y.com"))
    expect(headers.subject).toBe("a b")
    expect(headers.from).toBe("x@y.com")
  })

  test("keeps every value of a repeated header", () => {
    const headers = parseHeaders(lines("Received: one", "Received: two"))
    expect(headers.received).toBe("one\ntwo")
  })
})

describe("parseMessage", () => {
  test("parses a simple text message", () => {
    const raw = lines("From: a@x.com", "To: b@y.com", "Subject: Hi", "", "Hello there")
    const parsed = parseMessage(raw)
    expect(parsed.headers.subject).toBe("Hi")
    expect(parsed.to).toEqual(["b@y.com"])
    expect(parsed.text).toBe("Hello there")
    expect(parsed.html).toBeNull()
  })

  test("decodes an encoded subject", () => {
    const raw = lines("From: a@x.com", "Subject: =?UTF-8?B?SMOpbGxv?=", "", "body")
    expect(parseMessage(raw).headers.subject).toBe("Héllo")
  })

  test("splits multipart/alternative into text and html", () => {
    const raw = lines(
      "From: a@x.com",
      "To: b@y.com",
      'Content-Type: multipart/alternative; boundary="BOUND"',
      "",
      "--BOUND",
      "Content-Type: text/plain",
      "",
      "plain body",
      "--BOUND",
      "Content-Type: text/html",
      "",
      "<p>html body</p>",
      "--BOUND--",
      "",
    )
    const parsed = parseMessage(raw)
    expect(parsed.text).toBe("plain body")
    expect(parsed.html).toBe("<p>html body</p>")
  })

  test("extracts a base64 attachment", () => {
    const raw = lines(
      "From: a@x.com",
      'Content-Type: multipart/mixed; boundary="B"',
      "",
      "--B",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--B",
      'Content-Type: application/pdf; name="doc.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="doc.pdf"',
      "",
      Buffer.from("PDF-DATA").toString("base64"),
      "--B--",
      "",
    )
    const parsed = parseMessage(raw)
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]!.filename).toBe("doc.pdf")
    expect(parsed.attachments[0]!.contentType).toBe("application/pdf")
    expect(parsed.attachments[0]!.content.toString("utf8")).toBe("PDF-DATA")
    expect(parsed.text).toBe("see attached")
  })

  test("decodes a quoted-printable body", () => {
    const raw = lines(
      "From: a@x.com",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "H=C3=A9llo",
    )
    expect(parseMessage(raw).text).toBe("Héllo")
  })

  test("parses a comma-separated recipient list", () => {
    const raw = lines("From: a@x.com", 'To: "Last, First" <b@y.com>, c@z.com', "", "body")
    expect(parseMessage(raw).to).toEqual(['"Last, First" <b@y.com>', "c@z.com"])
  })

  test("keeps an inline image with its Content-ID", () => {
    const raw = lines(
      "From: a@x.com",
      'Content-Type: multipart/related; boundary="R"',
      "",
      "--R",
      "Content-Type: text/html",
      "",
      '<img src="cid:logo">',
      "--R",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      Buffer.from("PNG").toString("base64"),
      "--R--",
      "",
    )
    const parsed = parseMessage(raw)
    expect(parsed.attachments[0]!.contentId).toBe("logo")
    expect(parsed.html).toContain("cid:logo")
  })
})
