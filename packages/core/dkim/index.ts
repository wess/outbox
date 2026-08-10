import { createHash, createSign, generateKeyPairSync } from "node:crypto"

const CRLF = "\r\n"

export type DkimKeyPair = { privateKey: string; publicKey: string }

// 1024-bit keeps the TXT record inside a single 255-char string, which is what
// most DNS UIs accept without manual splitting. 2048 is available for operators
// who want it and can handle the chunked record.
export const generateDkimKeys = (bits: 1024 | 2048 = 1024): DkimKeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return { privateKey, publicKey }
}

// The base64 body of the SPKI PEM, which is what goes in the `p=` tag.
export const publicKeyTag = (publicKeyPem: string): string =>
  publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "")

export const dkimRecordValue = (publicKeyPem: string): string =>
  `v=DKIM1; k=rsa; p=${publicKeyTag(publicKeyPem)}`

const splitHeaders = (raw: string): { headers: string[]; body: string } => {
  const idx = raw.indexOf(`${CRLF}${CRLF}`)
  if (idx === -1) return { headers: raw.split(CRLF), body: "" }
  const headerBlock = raw.slice(0, idx)
  const body = raw.slice(idx + 4)
  // Unfold continuation lines so each entry is one logical header.
  const lines = headerBlock.split(CRLF)
  const headers: string[] = []
  for (const line of lines) {
    if (/^[ \t]/.test(line) && headers.length > 0) headers[headers.length - 1] += CRLF + line
    else headers.push(line)
  }
  return { headers, body }
}

const headerName = (header: string): string =>
  header.slice(0, header.indexOf(":")).trim().toLowerCase()

// RFC 6376 §3.4.2 — relaxed header canonicalization.
export const canonicalizeHeaderRelaxed = (header: string): string => {
  const colon = header.indexOf(":")
  const name = header.slice(0, colon).trim().toLowerCase()
  const value = header
    .slice(colon + 1)
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
  return `${name}:${value}`
}

// RFC 6376 §3.4.4 — relaxed body canonicalization.
export const canonicalizeBodyRelaxed = (body: string): string => {
  const normalized = body
    .split(CRLF)
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    .join(CRLF)
  const trimmed = normalized.replace(/(?:\r\n)+$/, "")
  return trimmed.length === 0 ? "" : trimmed + CRLF
}

export type DkimOptions = {
  domain: string
  selector: string
  privateKey: string
  headersToSign?: readonly string[]
  signedAt?: Date
}

const DEFAULT_SIGNED_HEADERS = [
  "from",
  "to",
  "cc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "list-unsubscribe",
] as const

/**
 * Returns the raw message with a DKIM-Signature header prepended.
 * relaxed/relaxed canonicalization, rsa-sha256.
 */
export const signDkim = (raw: string, opts: DkimOptions): string => {
  const { headers, body } = splitHeaders(raw)
  const wanted = opts.headersToSign ?? DEFAULT_SIGNED_HEADERS

  // Sign each named header at most once, in the order they appear in `wanted`.
  const selected: string[] = []
  const names: string[] = []
  for (const name of wanted) {
    const found = headers.find((h) => headerName(h) === name && !names.includes(name))
    if (!found) continue
    selected.push(found)
    names.push(name)
  }

  const bodyHash = createHash("sha256")
    .update(canonicalizeBodyRelaxed(body), "utf8")
    .digest("base64")
  const timestamp = Math.floor((opts.signedAt ?? new Date()).getTime() / 1000)

  const tags = [
    "v=1",
    "a=rsa-sha256",
    "c=relaxed/relaxed",
    `d=${opts.domain}`,
    `s=${opts.selector}`,
    `t=${timestamp}`,
    `h=${names.join(":")}`,
    `bh=${bodyHash}`,
    "b=",
  ].join("; ")

  const unsignedHeader = `DKIM-Signature: ${tags}`
  const canonical = [
    ...selected.map(canonicalizeHeaderRelaxed),
    canonicalizeHeaderRelaxed(unsignedHeader),
  ].join(CRLF)

  const signer = createSign("RSA-SHA256")
  signer.update(canonical, "utf8")
  const signature = signer.sign(opts.privateKey, "base64")

  const wrapped = (signature.match(/.{1,72}/g) ?? [signature]).join(`${CRLF} `)
  return `DKIM-Signature: ${tags}${wrapped}${CRLF}${raw}`
}
