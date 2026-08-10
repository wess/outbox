import { useCallback, useEffect, useRef, useState } from "react"
import { get, RequestError } from "./api.ts"

export type Async<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Fetches on mount and whenever `path` changes; `reload` refetches on demand. */
export const useResource = <T>(path: string | null): Async<T> => {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [nonce, setNonce] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    if (!path) {
      setData(null)
      setLoading(false)
      return
    }
    const ticket = ++latest.current
    setLoading(true)
    get<T>(path)
      .then((value) => {
        // Drop responses from a superseded request.
        if (ticket !== latest.current) return
        setData(value)
        setError(null)
      })
      .catch((err: unknown) => {
        if (ticket !== latest.current) return
        setError(err instanceof RequestError ? err.message : String(err))
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false)
      })
  }, [path, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

/** Debounces a value so typing in a search box does not fire a request a keystroke. */
export const useDebounced = <T>(value: T, ms = 250): T => {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export type Toast = { message: string; kind: "info" | "error" } | null

export const useToast = () => {
  const [toast, setToast] = useState<Toast>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])
  const show = useCallback((message: string) => setToast({ message, kind: "info" }), [])
  const fail = useCallback((err: unknown) => {
    setToast({ message: err instanceof Error ? err.message : String(err), kind: "error" })
  }, [])
  return { toast, show, fail }
}
