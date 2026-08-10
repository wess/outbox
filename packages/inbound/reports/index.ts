/**
 * Delivery status notifications and feedback reports.
 *
 * A message that leaves Outbox carries a VERP return path — `bounces+<email
 * id>@<return path>.<domain>` — so anything that fails *after* the receiving
 * server accepted it comes back here rather than vanishing. That is most real
 * bounces: "user unknown" and "mailbox full" are usually discovered after the
 * 250, not before it.
 *
 * Two formats matter:
 *
 *   RFC 3464  multipart/report; report-type=delivery-status  — bounces
 *   RFC 5965  multipart/report; report-type=feedback-report  — spam complaints
 */
import { type Part, paramOf, parseHeaders, splitHeaders, splitParts } from "../parser/index.ts"

export type DsnAction = "failed" | "delayed" | "delivered" | "relayed" | "expanded"

export type DeliveryStatus = {
  recipient: string | null
  action: DsnAction
  /** RFC 3463 `class.subject.detail`, e.g. `5.1.1`. */
  status: string | null
  /** 2 success, 4 transient, 5 permanent. Null when the status is unparseable. */
  statusClass: 2 | 4 | 5 | null
  diagnosticCode: string | null
  remoteMta: string | null
}

export type BounceReport = {
  kind: "dsn"
  reportingMta: string | null
  recipients: DeliveryStatus[]
  originalMessageId: string | null
  raw: string
}

export type ComplaintReport = {
  kind: "arf"
  /** abuse | fraud | virus | not-spam | other */
  feedbackType: string
  originalMessageId: string | null
  originalRecipient: string | null
  reportedBy: string | null
  raw: string
}

export type Report = BounceReport | ComplaintReport

const partsOf = (headers: Record<string, string>, body: string): Part[] => {
  const boundary = paramOf(headers["content-type"] ?? "", "boundary")
  return boundary ? splitParts(body, boundary) : []
}

const mimeOf = (part: Part): string =>
  (part.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase()

const findPart = (parts: Part[], mime: string): Part | undefined =>
  parts.find((p) => mimeOf(p) === mime)

/**
 * `message/delivery-status` is header groups separated by blank lines: one
 * per-message group, then one per recipient.
 */
const statusGroups = (body: string): Record<string, string>[] =>
  body
    .replace(/\r?\n/g, "\r\n")
    .split(/\r\n\r\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseHeaders)

// `rfc822;user@example.com` — the address type prefix is not part of the value.
const stripType = (value: string | undefined): string | null => {
  if (!value) return null
  const semi = value.indexOf(";")
  const raw = (semi === -1 ? value : value.slice(semi + 1)).trim()
  return raw.replace(/^<|>$/g, "") || null
}

const classOf = (status: string | null): 2 | 4 | 5 | null => {
  if (!status) return null
  const first = status.trim()[0]
  return first === "2" ? 2 : first === "4" ? 4 : first === "5" ? 5 : null
}

/**
 * Some MTAs omit Status but put the SMTP reply in Diagnostic-Code. A 5xx there
 * is just as authoritative, and treating a hard bounce as unknown would leave a
 * dead address on the list.
 */
const classFromDiagnostic = (diagnostic: string | null): 4 | 5 | null => {
  if (!diagnostic) return null
  const match = diagnostic.match(/\b([45])\d{2}\b/)
  if (!match) return null
  return match[1] === "5" ? 5 : 4
}

const messageIdFrom = (parts: Part[]): string | null => {
  // The original message comes back either whole or as headers only.
  const returned = findPart(parts, "message/rfc822") ?? findPart(parts, "text/rfc822-headers")
  if (!returned) return null
  const headers = parseHeaders(splitHeaders(returned.body).head)
  const id = headers["message-id"]
  return id ? id.trim() : null
}

const parseDsn = (
  headers: Record<string, string>,
  body: string,
  raw: string,
): BounceReport | null => {
  const parts = partsOf(headers, body)
  const status = findPart(parts, "message/delivery-status")
  if (!status) return null

  const groups = statusGroups(status.body)
  if (groups.length === 0) return null

  const perMessage = groups[0]!
  const recipients: DeliveryStatus[] = []

  for (const group of groups.slice(1)) {
    const recipient = stripType(group["original-recipient"]) ?? stripType(group["final-recipient"])
    const code = group.status?.trim() ?? null
    const diagnostic = group["diagnostic-code"]?.replace(/\s+/g, " ").trim() ?? null
    const action = (group.action?.trim().toLowerCase() ?? "failed") as DsnAction

    recipients.push({
      recipient,
      action,
      status: code,
      statusClass: classOf(code) ?? classFromDiagnostic(diagnostic),
      diagnosticCode: diagnostic,
      remoteMta: stripType(group["remote-mta"]),
    })
  }

  return {
    kind: "dsn",
    reportingMta: stripType(perMessage["reporting-mta"]),
    recipients,
    originalMessageId: messageIdFrom(parts),
    raw,
  }
}

const parseArf = (
  headers: Record<string, string>,
  body: string,
  raw: string,
): ComplaintReport | null => {
  const parts = partsOf(headers, body)
  const report = findPart(parts, "message/feedback-report")
  if (!report) return null

  const fields = parseHeaders(report.body.replace(/\r?\n/g, "\r\n").trim())

  return {
    kind: "arf",
    feedbackType: (fields["feedback-type"] ?? "other").trim().toLowerCase(),
    originalMessageId: fields["message-id"]?.trim() ?? messageIdFrom(parts),
    originalRecipient: stripType(fields["original-rcpt-to"]),
    reportedBy: fields["reporting-mta"]?.trim() ?? fields["user-agent"]?.trim() ?? null,
    raw,
  }
}

/**
 * Returns null when the message is not a report. Arriving at a bounce address
 * is itself evidence of failure, so the caller should still record something —
 * this only decides whether we can say *why*.
 */
export const parseReport = (raw: string): Report | null => {
  const { head, body } = splitHeaders(raw)
  const headers = parseHeaders(head)
  const contentType = headers["content-type"] ?? ""
  const mime = contentType.split(";")[0]!.trim().toLowerCase()

  if (mime !== "multipart/report") return null

  const reportType = (paramOf(contentType, "report-type") ?? "").toLowerCase()
  if (reportType === "feedback-report") return parseArf(headers, body, raw)
  if (reportType === "delivery-status" || reportType === "") {
    return parseDsn(headers, body, raw)
  }
  return null
}

// ------------------------------------------------------------ conclusions --

export type Verdict = {
  /** hard — do not send here again. soft — transient, retry is reasonable. */
  severity: "hard" | "soft" | "complaint" | "delivered" | "unknown"
  recipient: string | null
  status: string | null
  detail: string | null
}

/**
 * Reduces a report to what the sending side needs to act on. A DSN can name
 * several recipients; each becomes its own verdict, because one address failing
 * says nothing about the others.
 */
export const verdicts = (report: Report): Verdict[] => {
  if (report.kind === "arf") {
    return [
      {
        // not-spam is a retraction, not a complaint — treating it as one would
        // suppress an address for asking to *keep* receiving mail.
        severity: report.feedbackType === "not-spam" ? "unknown" : "complaint",
        recipient: report.originalRecipient,
        status: null,
        detail: `feedback-type ${report.feedbackType}`,
      },
    ]
  }

  return report.recipients.map((entry) => {
    const detail = entry.diagnosticCode ?? entry.status ?? null

    if (entry.action === "delivered" || entry.action === "relayed") {
      return {
        severity: "delivered" as const,
        recipient: entry.recipient,
        status: entry.status,
        detail,
      }
    }
    if (entry.action === "delayed" || entry.statusClass === 4) {
      return { severity: "soft" as const, recipient: entry.recipient, status: entry.status, detail }
    }
    if (entry.statusClass === 5) {
      return { severity: "hard" as const, recipient: entry.recipient, status: entry.status, detail }
    }
    return {
      severity: "unknown" as const,
      recipient: entry.recipient,
      status: entry.status,
      detail,
    }
  })
}

// --------------------------------------------------------------- addresses --

export type BounceAddress = { emailId: string | null; returnPath: string; domain: string }

/**
 * Splits `bounces+<email id>@send.acme.com` into its parts.
 *
 * The `+` tag is what ties a bounce back to the message that caused it, which
 * is more reliable than the returned Message-ID — plenty of MTAs return only a
 * truncated body, and some return nothing at all.
 */
export const parseBounceAddress = (address: string): BounceAddress | null => {
  const at = address.lastIndexOf("@")
  if (at === -1) return null

  const local = address.slice(0, at)
  const host = address.slice(at + 1).toLowerCase()
  if (!local.startsWith("bounces")) return null

  const plus = local.indexOf("+")
  const tag = plus === -1 ? null : local.slice(plus + 1)

  const dot = host.indexOf(".")
  if (dot === -1) return null

  return {
    emailId: tag && /^[0-9a-f-]{36}$/i.test(tag) ? tag : null,
    returnPath: host.slice(0, dot),
    domain: host.slice(dot + 1),
  }
}
