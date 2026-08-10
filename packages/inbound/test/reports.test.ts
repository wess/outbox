import { describe, expect, test } from "bun:test"
import {
  type BounceReport,
  type ComplaintReport,
  parseBounceAddress,
  parseReport,
  verdicts,
} from "../reports/index.ts"

const CRLF = "\r\n"
const lines = (...parts: string[]) => parts.join(CRLF)

// Shaped after what Postfix, Exim, and Google actually emit.
const dsn = (opts: {
  action?: string
  status?: string
  diagnostic?: string
  recipient?: string
  includeOriginal?: boolean
}) =>
  lines(
    "From: MAILER-DAEMON@mx.example.net",
    "To: bounces+4ef9a417-02e9-4d39-ad75-9611e0fcc33c@send.acme.com",
    "Subject: Undelivered Mail Returned to Sender",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"',
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "This is the mail system at host mx.example.net.",
    "",
    "--BOUND",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.example.net",
    "",
    `Final-Recipient: rfc822; ${opts.recipient ?? "user@example.com"}`,
    `Action: ${opts.action ?? "failed"}`,
    ...(opts.status ? [`Status: ${opts.status}`] : []),
    ...(opts.diagnostic ? [`Diagnostic-Code: smtp; ${opts.diagnostic}`] : []),
    "Remote-MTA: dns; mail.example.com",
    "",
    ...(opts.includeOriginal === false
      ? []
      : [
          "--BOUND",
          "Content-Type: message/rfc822",
          "",
          "Message-ID: <abc-123@acme.com>",
          "From: Acme <hi@acme.com>",
          "Subject: Hello",
          "",
          "body",
        ]),
    "--BOUND--",
    "",
  )

describe("parseBounceAddress", () => {
  test("splits a VERP bounce address", () => {
    expect(
      parseBounceAddress("bounces+4ef9a417-02e9-4d39-ad75-9611e0fcc33c@send.acme.com"),
    ).toEqual({
      emailId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
      returnPath: "send",
      domain: "acme.com",
    })
  })

  test("accepts an untagged bounce address", () => {
    expect(parseBounceAddress("bounces@send.acme.com")).toEqual({
      emailId: null,
      returnPath: "send",
      domain: "acme.com",
    })
  })

  test("ignores a tag that is not an email id", () => {
    expect(parseBounceAddress("bounces+nonsense@send.acme.com")?.emailId).toBeNull()
  })

  test("handles a multi-label domain", () => {
    expect(parseBounceAddress("bounces+x@send.mail.acme.co.uk")).toEqual({
      emailId: null,
      returnPath: "send",
      domain: "mail.acme.co.uk",
    })
  })

  test("rejects an ordinary address", () => {
    expect(parseBounceAddress("someone@acme.com")).toBeNull()
  })
})

describe("parseReport — DSN", () => {
  test("extracts the reporting MTA and recipient", () => {
    const report = parseReport(
      dsn({ status: "5.1.1", diagnostic: "550 5.1.1 User unknown" }),
    ) as BounceReport
    expect(report.kind).toBe("dsn")
    expect(report.reportingMta).toBe("mx.example.net")
    expect(report.recipients).toHaveLength(1)
    expect(report.recipients[0]!.recipient).toBe("user@example.com")
    expect(report.recipients[0]!.status).toBe("5.1.1")
    expect(report.recipients[0]!.statusClass).toBe(5)
    expect(report.recipients[0]!.remoteMta).toBe("mail.example.com")
  })

  test("recovers the original Message-ID from the returned message", () => {
    const report = parseReport(dsn({ status: "5.1.1" })) as BounceReport
    expect(report.originalMessageId).toBe("<abc-123@acme.com>")
  })

  test("tolerates a report with no returned message", () => {
    const report = parseReport(dsn({ status: "5.1.1", includeOriginal: false })) as BounceReport
    expect(report.originalMessageId).toBeNull()
    expect(report.recipients).toHaveLength(1)
  })

  test("infers the class from the SMTP reply when Status is missing", () => {
    const report = parseReport(dsn({ diagnostic: "550 5.1.1 User unknown" })) as BounceReport
    expect(report.recipients[0]!.status).toBeNull()
    expect(report.recipients[0]!.statusClass).toBe(5)
  })

  test("reads several recipients from one report", () => {
    const raw = lines(
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
      "",
      "--B",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.example.net",
      "",
      "Final-Recipient: rfc822; gone@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "",
      "Final-Recipient: rfc822; full@example.com",
      "Action: failed",
      "Status: 4.2.2",
      "",
      "--B--",
      "",
    )
    const report = parseReport(raw) as BounceReport
    expect(report.recipients.map((r) => r.recipient)).toEqual([
      "gone@example.com",
      "full@example.com",
    ])
    expect(report.recipients.map((r) => r.statusClass)).toEqual([5, 4])
  })

  test("prefers Original-Recipient when both are present", () => {
    const raw = lines(
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
      "",
      "--B",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.example.net",
      "",
      "Original-Recipient: rfc822; original@example.com",
      "Final-Recipient: rfc822; forwarded@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "",
      "--B--",
      "",
    )
    const report = parseReport(raw) as BounceReport
    expect(report.recipients[0]!.recipient).toBe("original@example.com")
  })

  test("returns null for a message that is not a report", () => {
    expect(parseReport(lines("Content-Type: text/plain", "", "just a normal email"))).toBeNull()
  })
})

describe("parseReport — ARF", () => {
  const arf = (feedbackType: string) =>
    lines(
      "From: complaints@isp.example",
      'Content-Type: multipart/report; report-type=feedback-report; boundary="F"',
      "",
      "--F",
      "Content-Type: text/plain",
      "",
      "This is an email abuse report.",
      "",
      "--F",
      "Content-Type: message/feedback-report",
      "",
      `Feedback-Type: ${feedbackType}`,
      "User-Agent: SomeISP/1.0",
      "Version: 1",
      "Original-Mail-From: bounces+4ef9a417-02e9-4d39-ad75-9611e0fcc33c@send.acme.com",
      "Original-Rcpt-To: annoyed@example.com",
      "",
      "--F",
      "Content-Type: message/rfc822",
      "",
      "Message-ID: <abc-123@acme.com>",
      "Subject: Hello",
      "",
      "--F--",
      "",
    )

  test("extracts the feedback type and recipient", () => {
    const report = parseReport(arf("abuse")) as ComplaintReport
    expect(report.kind).toBe("arf")
    expect(report.feedbackType).toBe("abuse")
    expect(report.originalRecipient).toBe("annoyed@example.com")
    expect(report.originalMessageId).toBe("<abc-123@acme.com>")
  })

  test("a complaint becomes a complaint verdict", () => {
    expect(verdicts(parseReport(arf("abuse")) as ComplaintReport)[0]!.severity).toBe("complaint")
  })

  test("not-spam is a retraction, not a complaint", () => {
    // Suppressing someone for asking to keep receiving mail would be backwards.
    expect(verdicts(parseReport(arf("not-spam")) as ComplaintReport)[0]!.severity).toBe("unknown")
  })
})

describe("verdicts", () => {
  const first = (raw: string) => verdicts(parseReport(raw)!)[0]!

  test("5.x.x is a hard bounce", () => {
    expect(first(dsn({ status: "5.1.1", diagnostic: "550 User unknown" })).severity).toBe("hard")
  })

  test("4.x.x is a soft bounce", () => {
    expect(first(dsn({ status: "4.2.2", diagnostic: "452 Mailbox full" })).severity).toBe("soft")
  })

  test("action=delayed is soft even with no status", () => {
    expect(first(dsn({ action: "delayed" })).severity).toBe("soft")
  })

  test("action=delivered is not a failure", () => {
    expect(first(dsn({ action: "delivered", status: "2.0.0" })).severity).toBe("delivered")
  })

  test("an unclassifiable report is unknown rather than a guess", () => {
    expect(first(dsn({ action: "failed" })).severity).toBe("unknown")
  })

  test("carries the diagnostic through as detail", () => {
    expect(first(dsn({ status: "5.1.1", diagnostic: "550 5.1.1 User unknown" })).detail).toContain(
      "User unknown",
    )
  })
})
