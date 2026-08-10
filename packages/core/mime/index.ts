import { randomBytes } from "node:crypto"
import { formatAddress, parseAddress, parseAddressList } from "../addresses/index.ts"

export type MimeAttachment = {
  filename: string
  content: Buffer
  contentType?: string | undefined
  contentId?: string | null | undefined
}

export type MimeMessage = {
  from: string
  to: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  replyTo?: string[] | undefined
  subject: string
  html?: string | null | undefined
  text?: string | null | undefined
  headers?: Record<string, string> | undefined
  messageId: string
  date?: Date | undefined
  attachments?: MimeAttachment[] | undefined
  listUnsubscribe?: string | undefined
  listUnsubscribePost?: boolean | undefined
}

const CRLF = "\r\n"

const boundary = (): string => `--=_Outbox_${randomBytes(16).toString("hex")}`

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false
  return true
}

// A bare CR or LF in a header value would end the header and let the caller
// inject their own (Bcc, extra recipients). Collapse them to spaces before the
// value is ever written, alongside the other C0 control characters.
const stripControls = (value: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  value.replace(/[\r\n]+/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")

// RFC 2047 encoded-word. Split on 60-char output chunks to stay inside the
// 75-char limit once the charset prefix is added.
export const encodeWord = (value: string): string => {
  const safe = stripControls(value)
  if (isAscii(safe) && !/[?=]/.test(safe)) return safe
  const b64 = Buffer.from(safe, "utf8").toString("base64")
  const chunks = b64.match(/.{1,60}/g) ?? [b64]
  return chunks.map((c) => `=?UTF-8?B?${c}?=`).join(`${CRLF} `)
}

const encodeAddressHeader = (raw: string): string => {
  const parsed = parseAddress(raw)
  // An unparseable value never reaches the wire as-is — it could carry a newline.
  if (!parsed) return stripControls(raw)
  const name = parsed.name === null ? null : stripControls(parsed.name)
  if (!name) return parsed.email
  if (isAscii(name)) return formatAddress({ name, email: parsed.email })
  return `${encodeWord(name)} <${parsed.email}>`
}

const encodeAddressList = (values: readonly string[]): string =>
  values.map(encodeAddressHeader).join(", ")

// Fold long header lines at 76 chars on whitespace (RFC 5322 §2.2.3).
// Header names are sanitised too, so a caller-supplied key cannot smuggle a
// newline either. Values arrive already encoded, which is where folding CRLFs
// legitimately come from.
const foldHeader = (rawName: string, value: string): string => {
  const name = rawName.replace(/[^\x21-\x39\x3b-\x7e]/g, "")
  const line = `${name}: ${value}`
  if (line.length <= 76 || value.includes(CRLF)) return line
  const words = line.split(" ")
  const out: string[] = []
  let current = ""
  for (const word of words) {
    if (current && `${current} ${word}`.length > 76) {
      out.push(current)
      current = ` ${word}`
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) out.push(current)
  return out.join(CRLF)
}

export const quotedPrintable = (input: string): string => {
  const bytes = Buffer.from(input, "utf8")
  let out = ""
  let lineLen = 0
  const push = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += `=${CRLF}`
      lineLen = 0
    }
    out += chunk
    lineLen += chunk.length
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out += CRLF
      lineLen = 0
      i++
      continue
    }
    if (b === 0x0a) {
      out += CRLF
      lineLen = 0
      continue
    }
    // Printable ASCII except '=' passes through; space/tab must be encoded at
    // end of line, so encode them only when they'd land there.
    if (b === 0x3d) push("=3D")
    else if (
      (b === 0x20 || b === 0x09) &&
      (bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d || i === bytes.length - 1)
    )
      push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`)
    else if (b >= 0x20 && b <= 0x7e) push(String.fromCharCode(b))
    else push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`)
  }
  return out
}

const base64Lines = (buf: Buffer): string =>
  (buf.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF)

const part = (headers: string[], body: string): string =>
  `${headers.join(CRLF)}${CRLF}${CRLF}${body}`

const textPart = (content: string, subtype: "plain" | "html"): string =>
  part(
    [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: quoted-printable"],
    quotedPrintable(content),
  )

const attachmentPart = (att: MimeAttachment, inline: boolean): string => {
  const type = att.contentType ?? "application/octet-stream"
  const disposition = inline ? "inline" : "attachment"
  const headers = [
    `Content-Type: ${type}; name="${encodeWord(att.filename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${encodeWord(att.filename)}"`,
  ]
  if (att.contentId) headers.push(`Content-ID: <${att.contentId.replace(/^<|>$/g, "")}>`)
  return part(headers, base64Lines(att.content))
}

const multipart = (subtype: string, parts: string[]): { body: string; contentType: string } => {
  const b = boundary()
  const body = [...parts.map((p) => `--${b}${CRLF}${p}`), `--${b}--${CRLF}`].join(CRLF)
  return { body, contentType: `multipart/${subtype}; boundary="${b}"` }
}

// Strip a plain-text fallback out of HTML so every message carries a text part.
export const htmlToText = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim()

export type BuiltMessage = { raw: string; headers: string[]; body: string }

/**
 * Builds an RFC 5322 message. Structure follows what the content requires:
 *
 *   text only                  -> text/plain
 *   html only                  -> multipart/alternative (text auto-derived)
 *   inline images              -> multipart/related wrapping the alternative
 *   attachments                -> multipart/mixed wrapping the above
 */
export const buildMime = (msg: MimeMessage): BuiltMessage => {
  const attachments = msg.attachments ?? []
  const inline = attachments.filter((a) => a.contentId)
  const attached = attachments.filter((a) => !a.contentId)

  const text = msg.text ?? (msg.html ? htmlToText(msg.html) : "")
  const hasText = text.length > 0
  const hasHtml = Boolean(msg.html && msg.html.length > 0)

  let contentType: string
  let body: string

  const alternatives: string[] = []
  if (hasText) alternatives.push(textPart(text, "plain"))
  if (hasHtml) alternatives.push(textPart(msg.html!, "html"))

  if (alternatives.length === 0) {
    contentType = "text/plain; charset=utf-8"
    body = ""
  } else if (alternatives.length === 1 && !hasHtml) {
    contentType = "text/plain; charset=utf-8"
    body = quotedPrintable(text)
  } else {
    const alt = multipart("alternative", alternatives)
    contentType = alt.contentType
    body = alt.body
  }

  const wrapContent = () =>
    part(
      [
        `Content-Type: ${contentType}`,
        ...(alternatives.length === 1 && !hasHtml
          ? ["Content-Transfer-Encoding: quoted-printable"]
          : []),
      ],
      body,
    )

  if (inline.length > 0) {
    const related = multipart("related", [
      wrapContent(),
      ...inline.map((a) => attachmentPart(a, true)),
    ])
    contentType = related.contentType
    body = related.body
  }

  if (attached.length > 0) {
    const mixed = multipart("mixed", [
      wrapContent(),
      ...attached.map((a) => attachmentPart(a, false)),
    ])
    contentType = mixed.contentType
    body = mixed.body
  }

  const isSimpleText = !hasHtml && inline.length === 0 && attached.length === 0

  const headers: string[] = [
    foldHeader("From", encodeAddressHeader(msg.from)),
    foldHeader("To", encodeAddressList(msg.to)),
  ]
  if (msg.cc?.length) headers.push(foldHeader("Cc", encodeAddressList(msg.cc)))
  if (msg.replyTo?.length) headers.push(foldHeader("Reply-To", encodeAddressList(msg.replyTo)))
  headers.push(foldHeader("Subject", encodeWord(msg.subject)))
  headers.push(`Message-ID: ${msg.messageId}`)
  headers.push(`Date: ${(msg.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`)
  headers.push("MIME-Version: 1.0")

  if (msg.listUnsubscribe) {
    headers.push(foldHeader("List-Unsubscribe", msg.listUnsubscribe))
    if (msg.listUnsubscribePost) headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click")
  }

  for (const [k, v] of Object.entries(msg.headers ?? {})) {
    const lower = k.toLowerCase()
    // Callers must not forge routing or identity headers.
    if (
      [
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "message-id",
        "date",
        "mime-version",
        "content-type",
        "content-transfer-encoding",
        "dkim-signature",
      ].includes(lower)
    )
      continue
    headers.push(foldHeader(k, encodeWord(String(v))))
  }

  headers.push(`Content-Type: ${contentType}`)
  if (isSimpleText) headers.push("Content-Transfer-Encoding: quoted-printable")

  return { raw: `${headers.join(CRLF)}${CRLF}${CRLF}${body}`, headers, body }
}

export const recipientsOf = (msg: Pick<MimeMessage, "to" | "cc" | "bcc">): string[] => {
  const all = [...msg.to, ...(msg.cc ?? []), ...(msg.bcc ?? [])]
  const emails = parseAddressList(all).map((a) => a.email)
  return Array.from(new Set(emails))
}
