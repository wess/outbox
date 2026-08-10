export type Address = { name: string | null; email: string }

const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,.]+(?:\.[^\s@<>,.]+)+$/

// Accepts `user@example.com`, `Name <user@example.com>`, and `"Last, First" <u@e.com>`.
export const parseAddress = (input: string): Address | null => {
  const value = input.trim()
  if (!value) return null

  const angled = value.match(/^(.*?)<([^>]+)>$/)
  if (angled) {
    const rawName = (angled[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim()
    const email = (angled[2] ?? "").trim()
    if (!EMAIL_RE.test(email)) return null
    return { name: rawName || null, email }
  }

  if (!EMAIL_RE.test(value)) return null
  return { name: null, email: value }
}

// Splits a header value on commas that sit outside quotes and angle brackets.
export const splitAddressList = (input: string): string[] => {
  const out: string[] = []
  let current = ""
  let inQuotes = false
  let depth = 0
  for (const ch of input) {
    if (ch === '"') inQuotes = !inQuotes
    if (!inQuotes && ch === "<") depth++
    if (!inQuotes && ch === ">") depth--
    if (ch === "," && !inQuotes && depth <= 0) {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

export const parseAddressList = (input: string | string[] | null | undefined): Address[] => {
  if (!input) return []
  const parts = Array.isArray(input) ? input.flatMap(splitAddressList) : splitAddressList(input)
  const out: Address[] = []
  for (const part of parts) {
    const parsed = parseAddress(part)
    if (parsed) out.push(parsed)
  }
  return out
}

export const isValidEmail = (value: string): boolean => EMAIL_RE.test(value.trim())

export const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1).toLowerCase()

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

export const formatAddress = (addr: Address): string => {
  if (!addr.name) return addr.email
  const needsQuotes = /[",;:<>@[\]\\]/.test(addr.name)
  const name = needsQuotes ? `"${addr.name.replace(/(["\\])/g, "\\$1")}"` : addr.name
  return `${name} <${addr.email}>`
}

// Normalises the many shapes the API accepts (string, array, comma list) into
// a flat array of raw address strings.
export const toAddressArray = (input: string | string[] | null | undefined): string[] => {
  if (input === null || input === undefined) return []
  const list = Array.isArray(input) ? input : [input]
  return list.flatMap((v) => splitAddressList(String(v))).filter(Boolean)
}
