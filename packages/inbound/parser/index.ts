export type ParsedAttachment = {
  filename: string
  contentType: string
  contentId: string | null
  content: Buffer
}

export type ParsedMessage = {
  headers: Record<string, string>
  to: string[]
  cc: string[]
  html: string | null
  text: string | null
  attachments: ParsedAttachment[]
}

const CRLF = "\r\n"

// RFC 2047 encoded-words in header values (=?UTF-8?B?...?= / =?UTF-8?Q?...?=).
export const decodeWords = (value: string): string =>
  value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_m, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(text, "base64")
            : Buffer.from(
                text
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) =>
                    String.fromCharCode(Number.parseInt(hex, 16)),
                  ),
                "binary",
              )
        return new TextDecoder(charset.toLowerCase()).decode(bytes)
      } catch {
        return text
      }
    },
  )

export const decodeQuotedPrintable = (input: string): Buffer => {
  const joined = input.replace(/=\r?\n/g, "")
  const bytes: number[] = []
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!
    if (ch === "=" && i + 2 < joined.length) {
      const hex = joined.slice(i + 1, i + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff)
  }
  return Buffer.from(bytes)
}

const splitHeaders = (raw: string): { head: string; body: string } => {
  const normalized = raw.replace(/\r?\n/g, CRLF)
  const idx = normalized.indexOf(`${CRLF}${CRLF}`)
  if (idx === -1) return { head: normalized, body: "" }
  return { head: normalized.slice(0, idx), body: normalized.slice(idx + 4) }
}

export const parseHeaders = (head: string): Record<string, string> => {
  const out: Record<string, string> = {}
  // Unfold continuation lines before splitting on the colon.
  const lines = head.split(CRLF)
  const logical: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && logical.length) logical[logical.length - 1] += ` ${line.trim()}`
    else logical.push(line)
  }
  for (const line of logical) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = decodeWords(line.slice(colon + 1).trim())
    // Repeated headers (Received, etc.) keep every value.
    out[name] = out[name] ? `${out[name]}\n${value}` : value
  }
  return out
}

const paramOf = (value: string, key: string): string | null => {
  const match = value.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"|${key}\\s*=\\s*([^;\\s]+)`, "i"))
  return match ? (match[1] ?? match[2] ?? null) : null
}

const decodeBody = (body: string, encoding: string, charset: string): Buffer => {
  const enc = encoding.toLowerCase()
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64")
  if (enc === "quoted-printable") return decodeQuotedPrintable(body)
  return Buffer.from(body, charset.toLowerCase() === "utf-8" ? "utf8" : "binary")
}

const asText = (buffer: Buffer, charset: string): string => {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buffer)
  } catch {
    return buffer.toString("utf8")
  }
}

type Part = { headers: Record<string, string>; body: string }

const splitParts = (body: string, boundary: string): Part[] => {
  const marker = `--${boundary}`
  const segments = body.split(marker)
  const parts: Part[] = []
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) break
    const trimmed = segment.replace(/^\r?\n/, "")
    const { head, body: partBody } = splitHeaders(trimmed)
    parts.push({ headers: parseHeaders(head), body: partBody.replace(/\r\n$/, "") })
  }
  return parts
}

const addressList = (value: string | undefined): string[] => {
  if (!value) return []
  const out: string[] = []
  let current = ""
  let quoted = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    if (ch === "," && !quoted) {
      out.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out.filter(Boolean)
}

const walk = (
  headers: Record<string, string>,
  body: string,
  acc: { html: string | null; text: string | null; attachments: ParsedAttachment[] },
): void => {
  const contentType = headers["content-type"] ?? "text/plain"
  const encoding = headers["content-transfer-encoding"] ?? "7bit"
  const disposition = headers["content-disposition"] ?? ""
  const charset = paramOf(contentType, "charset") ?? "utf-8"
  const mime = contentType.split(";")[0]!.trim().toLowerCase()

  if (mime.startsWith("multipart/")) {
    const boundary = paramOf(contentType, "boundary")
    if (!boundary) return
    for (const part of splitParts(body, boundary)) walk(part.headers, part.body, acc)
    return
  }

  const filename = paramOf(disposition, "filename") ?? paramOf(contentType, "name") ?? null
  const isAttachment = disposition.toLowerCase().startsWith("attachment") || Boolean(filename)

  if (isAttachment) {
    acc.attachments.push({
      filename: decodeWords(filename ?? "attachment"),
      contentType: mime,
      contentId: headers["content-id"]?.replace(/^<|>$/g, "") ?? null,
      content: decodeBody(body, encoding, charset),
    })
    return
  }

  const decoded = asText(decodeBody(body, encoding, charset), charset)
  if (mime === "text/html") acc.html = acc.html ? `${acc.html}\n${decoded}` : decoded
  else if (mime === "text/plain") acc.text = acc.text ? `${acc.text}\n${decoded}` : decoded
}

/** Parses a raw RFC 5322 message into headers, bodies, and attachments. */
export const parseMessage = (raw: string): ParsedMessage => {
  const { head, body } = splitHeaders(raw)
  const headers = parseHeaders(head)
  const acc = {
    html: null as string | null,
    text: null as string | null,
    attachments: [] as ParsedAttachment[],
  }
  walk(headers, body, acc)

  return {
    headers,
    to: addressList(headers.to),
    cc: addressList(headers.cc),
    html: acc.html,
    text: acc.text,
    attachments: acc.attachments,
  }
}
