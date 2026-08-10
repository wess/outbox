/**
 * Connection tokens.
 *
 * Pairing two services usually means copying a URL and a key into two separate
 * fields and getting one of them subtly wrong. A connection token is both, plus
 * a label, in a single opaque string — so connecting is one paste.
 *
 * The format is deliberately trivial and dependency-free, because the other
 * side has to implement it too:
 *
 *   <prefix>_<base64url(JSON({ v, url, key, name }))>
 *
 * It is **not** encrypted. It carries a credential and should be treated like
 * one: shown once, pasted, and not committed.
 */

export type ServiceConnection = {
  /** Format version, so a future change can be detected rather than guessed. */
  v: 1
  /** Base URL of the service that issued the token, without a trailing slash. */
  url: string
  /** API key the holder should present to that service. */
  key: string
  /** Human label, shown in the receiving UI so a stale token is identifiable. */
  name?: string
}

export const OUTBOX_PREFIX = "obxc"
export const INKLING_PREFIX = "inkc"

const toBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url")

const fromBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8")

export const encodeConnection = (prefix: string, connection: ServiceConnection): string =>
  `${prefix}_${toBase64Url(JSON.stringify(connection))}`

export class ConnectionTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectionTokenError"
  }
}

export const decodeConnection = (token: string, expectedPrefix?: string): ServiceConnection => {
  const trimmed = token.trim()
  const underscore = trimmed.indexOf("_")
  if (underscore === -1) throw new ConnectionTokenError("Not a connection token.")

  const prefix = trimmed.slice(0, underscore)
  if (expectedPrefix && prefix !== expectedPrefix) {
    throw new ConnectionTokenError(
      `This is a \`${prefix}\` token; a \`${expectedPrefix}\` token was expected.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(underscore + 1)))
  } catch {
    throw new ConnectionTokenError("Connection token is malformed.")
  }

  const value = parsed as Partial<ServiceConnection>
  if (value?.v !== 1) throw new ConnectionTokenError("Unsupported connection token version.")
  if (typeof value.url !== "string" || !/^https?:\/\//.test(value.url)) {
    throw new ConnectionTokenError("Connection token has no usable URL.")
  }
  if (typeof value.key !== "string" || value.key.length === 0) {
    throw new ConnectionTokenError("Connection token has no API key.")
  }

  return {
    v: 1,
    url: value.url.replace(/\/$/, ""),
    key: value.key,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
  }
}

/** Safe to log or show in a UI — keeps the URL, drops the credential. */
export const describeConnection = (connection: ServiceConnection): string =>
  `${connection.name ? `${connection.name} · ` : ""}${connection.url} (key ${connection.key.slice(0, 8)}…)`
