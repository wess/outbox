import { invalidParameter } from "../errors/index.ts"

const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  month: 2592000,
  months: 2592000,
  year: 31536000,
  years: 31536000,
}

const RELATIVE = /^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i
const BARE = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:from\s+now)?$/i

/**
 * Accepts ISO 8601 (`2026-08-05T11:52:01.858Z`) or the natural-language forms
 * Resend documents (`in 1 min`, `tomorrow`, `in 2 hours`).
 */
export const parseScheduledAt = (
  input: string | null | undefined,
  now: Date = new Date(),
): Date | null => {
  if (input === null || input === undefined || input === "") return null
  const value = String(input).trim()

  const lower = value.toLowerCase()
  if (lower === "now") return new Date(now)
  if (lower === "tomorrow") return new Date(now.getTime() + 86400_000)

  const relative = value.match(RELATIVE) ?? value.match(BARE)
  if (relative) {
    const amount = Number(relative[1])
    const unit = UNITS[(relative[2] ?? "").toLowerCase()]
    if (unit && Number.isFinite(amount)) return new Date(now.getTime() + amount * unit * 1000)
  }

  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) return parsed

  throw invalidParameter(
    "`scheduled_at` must be an ISO 8601 date or a natural language offset such as `in 1 min`.",
  )
}

// A schedule in the past sends immediately rather than erroring, matching how
// providers treat clock skew between client and server.
export const normalizeSchedule = (at: Date | null, now: Date = new Date()): Date | null =>
  at && at.getTime() > now.getTime() ? at : null
