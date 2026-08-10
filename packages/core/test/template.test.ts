import { describe, expect, test } from "bun:test"
import { normalizeSchedule, parseScheduledAt } from "../scheduling/index.ts"
import { contactContext, extractVariables, hasUnsubscribeToken, render } from "../template/index.ts"

describe("render", () => {
  test("substitutes a triple-mustache variable", () => {
    expect(render("Hi {{{NAME}}}", { NAME: "Ada" })).toBe("Hi Ada")
  })

  test("uses the inline fallback when the value is missing", () => {
    expect(render("Hi {{{name|there}}}", {})).toBe("Hi there")
  })

  test("uses the inline fallback when the value is empty", () => {
    expect(render("Hi {{{name|there}}}", { name: "" })).toBe("Hi there")
  })

  test("prefers a real value over the fallback", () => {
    expect(render("Hi {{{name|there}}}", { name: "Ada" })).toBe("Hi Ada")
  })

  test("falls back to a declared variable default", () => {
    expect(render("Total {{{PRICE}}}", {}, { fallbacks: { PRICE: 25 } })).toBe("Total 25")
  })

  test("resolves dotted paths", () => {
    expect(render("Hi {{{contact.first_name}}}", { contact: { first_name: "Ada" } })).toBe("Hi Ada")
  })

  test("renders an unknown variable as empty", () => {
    expect(render("Hi {{{nope}}}", {})).toBe("Hi ")
  })

  test("double braces escape HTML", () => {
    expect(render("{{name}}", { name: "<script>" })).toBe("&lt;script&gt;")
  })

  test("triple braces do not escape", () => {
    expect(render("{{{html}}}", { html: "<b>hi</b>" })).toBe("<b>hi</b>")
  })

  test("renders numbers and booleans", () => {
    expect(render("{{{n}}} {{{b}}}", { n: 42, b: true })).toBe("42 true")
  })

  test("returns an empty string for empty input", () => {
    expect(render(null, {})).toBe("")
  })
})

describe("extractVariables", () => {
  test("collects every referenced key once", () => {
    expect(extractVariables("{{{A}}} {{{B|x}}} {{{A}}} {{C}}").sort()).toEqual(["A", "B", "C"])
  })
})

describe("hasUnsubscribeToken", () => {
  test("recognises both the Outbox and Resend token names", () => {
    expect(hasUnsubscribeToken("{{{OUTBOX_UNSUBSCRIBE_URL}}}")).toBe(true)
    expect(hasUnsubscribeToken("{{{RESEND_UNSUBSCRIBE_URL}}}")).toBe(true)
    expect(hasUnsubscribeToken("nothing here")).toBe(false)
  })
})

describe("contactContext", () => {
  test("exposes contact fields and flattens properties", () => {
    const ctx = contactContext({
      email: "a@x.com",
      first_name: "Ada",
      last_name: null,
      properties: { company: "Acme" },
    })
    expect(render("{{{contact.first_name}}} at {{{company}}}", ctx)).toBe("Ada at Acme")
  })

  test("a missing last name renders empty rather than null", () => {
    const ctx = contactContext({ email: "a@x.com", first_name: "Ada", last_name: null })
    expect(render("[{{{contact.last_name}}}]", ctx)).toBe("[]")
  })
})

describe("parseScheduledAt", () => {
  const now = new Date("2026-01-01T00:00:00Z")

  test("returns null for an absent value", () => {
    expect(parseScheduledAt(undefined, now)).toBeNull()
    expect(parseScheduledAt("", now)).toBeNull()
  })

  test("parses ISO 8601", () => {
    expect(parseScheduledAt("2026-01-02T03:04:05Z", now)?.toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    )
  })

  test("parses `in N unit` offsets", () => {
    expect(parseScheduledAt("in 1 min", now)?.toISOString()).toBe("2026-01-01T00:01:00.000Z")
    expect(parseScheduledAt("in 2 hours", now)?.toISOString()).toBe("2026-01-01T02:00:00.000Z")
    expect(parseScheduledAt("in 3 days", now)?.toISOString()).toBe("2026-01-04T00:00:00.000Z")
  })

  test("parses `tomorrow`", () => {
    expect(parseScheduledAt("tomorrow", now)?.toISOString()).toBe("2026-01-02T00:00:00.000Z")
  })

  test("throws on an unparseable value", () => {
    expect(() => parseScheduledAt("whenever you feel like it", now)).toThrow()
  })
})

describe("normalizeSchedule", () => {
  const now = new Date("2026-01-01T00:00:00Z")

  test("keeps a future time", () => {
    const future = new Date("2026-01-02T00:00:00Z")
    expect(normalizeSchedule(future, now)).toBe(future)
  })

  test("treats a past time as send-now", () => {
    expect(normalizeSchedule(new Date("2025-01-01T00:00:00Z"), now)).toBeNull()
  })
})
