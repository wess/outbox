import type { ReactNode } from "react"
import { useEffect, useState } from "react"

export const Icon = ({ path, size = 16 }: { path: string; size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
)

export const icons = {
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1 8 7 8-7",
  broadcast:
    "M12 12v.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13",
  automation: "M5 4h5v5H5zM14 15h5v5h-5zM7.5 9v3a3 3 0 0 0 3 3H14",
  template: "M4 4h6v16H4zM14 4h6v7h-6zM14 15h6v5h-6z",
  audience:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M17 11a3 3 0 1 0 0-6M18 20a6 6 0 0 0-2-4.5",
  metrics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  domain: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z",
  logs: "M3 6h18v12H3zM7 10h10M7 14h6",
  key: "M14 7a4 4 0 1 1-3.4 6.1L4 20H2v-2l6.9-6.6A4 4 0 0 1 14 7zm2.5 2.5h.01",
  webhook: "M9 9a3 3 0 1 1 5 2.2l2.5 4.3M8 15H5.5a3 3 0 1 0 2.9 3.8M15.5 15H19a3 3 0 1 0-2.6-4.5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1.1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  copy: "M9 9h10v10H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  back: "M15 18l-6-6 6-6",
  refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5",
  check: "M20 6L9 17l-5-5",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
}

export const Spinner = () => <div className="spinner" />

export const Loading = () => (
  <div className="loading">
    <Spinner />
  </div>
)

export const Empty = ({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string
  title: string
  description: string
  action?: ReactNode
}) => (
  <div className="empty">
    <div className="empty-icon">{emoji}</div>
    <h3>{title}</h3>
    <p>{description}</p>
    {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
  </div>
)

export const PageHead = ({ title, actions }: { title: string; actions?: ReactNode }) => (
  <div className="page-head">
    <h1>{title}</h1>
    {actions ? <div className="row">{actions}</div> : null}
  </div>
)

export const Card = ({ children, pad }: { children: ReactNode; pad?: boolean }) => (
  <div className={`card${pad ? " card-pad" : ""}`}>{children}</div>
)

export const Modal = ({
  title,
  subtitle,
  children,
  onClose,
  actions,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  actions?: ReactNode
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="overlay">
      {/* A real button rather than a click handler on the backdrop: it is
          reachable by keyboard and announced, and Escape still works. */}
      <button
        type="button"
        className="overlay-backdrop"
        aria-label="Close dialog"
        onClick={onClose}
      />
      <div className="modal" role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  delivered: "ok",
  sent: "info",
  verified: "ok",
  enabled: "ok",
  published: "ok",
  completed: "ok",
  opened: "ok",
  clicked: "ok",
  queued: "",
  scheduled: "warn",
  sending: "warn",
  pending: "warn",
  draft: "",
  waiting: "warn",
  running: "warn",
  not_started: "",
  delivery_delayed: "warn",
  temporary_failure: "warn",
  bounced: "bad",
  failed: "bad",
  complained: "bad",
  canceled: "bad",
  suppressed: "bad",
  exhausted: "bad",
  disabled: "",
}

export const Badge = ({ value, tone }: { value: string; tone?: string }) => (
  <span className={`badge ${tone ?? STATUS_TONE[value] ?? ""}`}>{value.replace(/_/g, " ")}</span>
)

export const Copyable = ({ value, label }: { value: string; label?: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
        } catch {
          // Clipboard access can be denied; the value stays visible either way.
        }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      title="Copy"
    >
      <Icon path={copied ? icons.check : icons.copy} size={13} />
      {label ?? (copied ? "Copied" : "Copy")}
    </button>
  )
}

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) => (
  // The control is nested inside this label, which associates them without a
  // generated id on every caller. Biome cannot see through `children`.
  // biome-ignore lint/a11y/noLabelWithoutControl: control is nested via children
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint ? <div className="hint">{hint}</div> : null}
  </label>
)

/**
 * The API renders timestamps the way Resend does — `2026-04-03 22:13:42.67+00`.
 * That trailing `+00` is not a valid ISO offset, so it needs padding to `+00:00`
 * before Date will parse it.
 */
export const parseTimestamp = (value: string | null | undefined): Date | null => {
  if (!value) return null
  const iso = value.includes("T") ? value : value.replace(" ", "T")
  const normalized = /[+-]\d{2}$/.test(iso) ? `${iso}:00` : iso
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

export const relativeTime = (value: string | null | undefined): string => {
  const date = parseTimestamp(value)
  if (!date) return "—"
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return seconds >= 0 ? "just now" : "in a moment"
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2592000, "month"],
    [31536000, "year"],
  ]
  let chosen = units[0]!
  for (const unit of units) if (abs >= unit[0]) chosen = unit
  const amount = Math.floor(abs / chosen[0])
  const plural = amount === 1 ? "" : "s"
  return seconds >= 0 ? `${amount} ${chosen[1]}${plural} ago` : `in ${amount} ${chosen[1]}${plural}`
}

export const formatDate = (value: string | null | undefined): string => {
  const date = parseTimestamp(value)
  if (!date) return "—"
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export const Pager = ({
  hasMore,
  onNext,
  onPrev,
  canPrev,
}: {
  hasMore: boolean
  onNext: () => void
  onPrev: () => void
  canPrev: boolean
}) => {
  if (!hasMore && !canPrev) return null
  return (
    <div className="pager">
      <button type="button" className="btn btn-sm" disabled={!canPrev} onClick={onPrev}>
        Previous
      </button>
      <button type="button" className="btn btn-sm" disabled={!hasMore} onClick={onNext}>
        Next
      </button>
    </div>
  )
}
