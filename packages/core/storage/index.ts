/**
 * Blob storage for attachments and raw messages.
 *
 * Everything else Outbox keeps is small and relational. Attachments and stored
 * raw MIME are neither: a single 40MB attachment is larger than most teams'
 * entire `emails` table, and base64 in a `text` column costs a third again on
 * top. Left in Postgres they dominate the database, every backup carries them,
 * and the disk fills long before the row count becomes interesting.
 *
 * So blobs go to an S3-compatible bucket and Postgres keeps a key.
 *
 * **Storage is optional.** With no bucket configured, content stays inline in
 * the column exactly as before. A self-hoster running one instance for their own
 * transactional mail should not have to stand up object storage first, and the
 * read path handles both shapes for as long as any old row survives — this is a
 * forward migration, not a cutover.
 */
import { config } from "@outbox/config"

export type BlobRef = {
  /** Set when the bytes live in the bucket. */
  storageKey: string | null
  /** Set when they are inline in the column. Base64, as the column always was. */
  content: string | null
}

/** What the read path accepts — either shape of a persisted blob. */
export type StoredBlob = {
  storage_key?: string | null
  content?: string | null
}

export type StorageSettings = {
  bucket: string
  region: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
}

let client: Bun.S3Client | null = null

// Held in a variable rather than read from `config` at each use, so that a test
// — or an embedder wiring Outbox up in process — can choose which mode it is
// exercising instead of inheriting whatever happens to be in the environment.
let settings: StorageSettings = { ...config.storage }

export const configureStorage = (next: Partial<StorageSettings>): void => {
  settings = { ...settings, ...next }
  client = null
}

export const storageSettings = (): StorageSettings => ({ ...settings })

export const storageConfigured = (): boolean =>
  Boolean(settings.bucket && settings.accessKeyId && settings.secretAccessKey)

/**
 * Built once and reused. Constructing it per call would be harmless but wasteful
 * on the delivery path, which touches every attachment of every message.
 */
const clientOf = (): Bun.S3Client => {
  if (client) return client
  client = new Bun.S3Client({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    bucket: settings.bucket,
    region: settings.region,
    // Empty means AWS proper, where Bun derives the endpoint from the region.
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
  })
  return client
}

const slug = (filename: string): string => {
  const cleaned = filename
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
  return cleaned || "file"
}

/**
 * Keys are namespaced by team so one bucket can serve every tenant and a team's
 * objects can be listed — or deleted — without consulting the database. The
 * random id rather than the row id is deliberate: the bytes are uploaded before
 * the row exists, so that a storage failure aborts the send without leaving a
 * half-written email behind.
 */
export const blobKey = (kind: string, teamId: string, filename: string): string => {
  const prefix = settings.prefix ? `${settings.prefix.replace(/\/+$/, "")}/` : ""
  return `${prefix}${kind}/${teamId}/${crypto.randomUUID()}/${slug(filename)}`
}

/**
 * Retries a bucket operation a few times before giving up.
 *
 * Object storage is a network call on a path that used to be a local one, and
 * it fails occasionally for no lasting reason — a `ConnectionClosed` on the
 * first request of a process is the one seen most. Without this, a blip that
 * lasts 200ms rejects a send that would have worked, which is a much worse
 * trade than waiting a moment.
 *
 * Every operation here is idempotent — writes go to a key nothing else uses,
 * reads and deletes are naturally repeatable — so retrying is always safe.
 */
const RETRIES = 3

export const withRetry = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  let last: unknown
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await run()
    } catch (error) {
      last = error
      if (attempt === RETRIES) break
      // 100ms, then 200ms. Long enough to outlast a dropped connection,
      // short enough that a caller waiting on a send does not notice.
      await Bun.sleep(100 * attempt)
      console.warn(`[outbox] ${what} failed (attempt ${attempt}/${RETRIES}), retrying`)
    }
  }
  throw last
}

export const putBlob = async (
  key: string,
  bytes: Uint8Array,
  contentType = "application/octet-stream",
): Promise<void> => {
  await withRetry(`storage put ${key}`, () =>
    clientOf().file(key).write(bytes, { type: contentType }),
  )
}

export const getBlob = async (key: string): Promise<Buffer> =>
  Buffer.from(await withRetry(`storage get ${key}`, () => clientOf().file(key).arrayBuffer()))

/**
 * Deleting a blob is best-effort. A key that has already gone, or a bucket
 * having a bad minute, must not fail the request that removed the row — the
 * database is the record of what exists, and an orphaned object costs a
 * fraction of a cent.
 */
export const deleteBlob = async (key: string): Promise<boolean> => {
  try {
    await clientOf().file(key).delete()
    return true
  } catch (error) {
    console.warn(`[outbox] could not delete blob ${key}:`, (error as Error).message)
    return false
  }
}

export const deleteBlobs = async (keys: readonly (string | null | undefined)[]): Promise<void> => {
  if (!storageConfigured()) return
  await Promise.all(keys.filter((k): k is string => Boolean(k)).map(deleteBlob))
}

/**
 * Puts the bytes wherever they belong and returns the pair of columns to write.
 * Callers store both and never branch on configuration themselves.
 */
export const storeBlob = async (
  kind: string,
  teamId: string,
  filename: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<BlobRef> => {
  if (!storageConfigured()) {
    return { storageKey: null, content: Buffer.from(bytes).toString("base64") }
  }
  const key = blobKey(kind, teamId, filename)
  await putBlob(key, bytes, contentType)
  return { storageKey: key, content: null }
}

/**
 * Reads a blob back whichever way it was stored. Throws rather than returning
 * empty when a key is present but unreadable: on the delivery path an empty
 * buffer would quietly send a message with a zero-byte attachment, and a
 * failure that retries is much better than one that succeeds wrongly.
 */
export const loadBlob = async (row: StoredBlob): Promise<Buffer> => {
  if (row.storage_key) {
    if (!storageConfigured()) {
      throw new Error(
        `attachment is in object storage (${row.storage_key}) but no bucket is configured — set STORAGE_BUCKET`,
      )
    }
    return getBlob(row.storage_key)
  }
  return Buffer.from(row.content ?? "", "base64")
}

/** Text blobs — stored raw MIME — are UTF-8 rather than base64. */
export const storeText = async (
  kind: string,
  teamId: string,
  filename: string,
  value: string,
): Promise<{ storageKey: string | null; text: string | null }> => {
  if (!storageConfigured()) return { storageKey: null, text: value }
  const key = blobKey(kind, teamId, filename)
  await putBlob(key, Buffer.from(value, "utf8"), "message/rfc822")
  return { storageKey: key, text: null }
}

export const loadText = async (row: {
  raw_storage_key?: string | null
  raw?: string | null
}): Promise<string | null> => {
  if (row.raw_storage_key) {
    if (!storageConfigured()) return null
    return (await getBlob(row.raw_storage_key)).toString("utf8")
  }
  return row.raw ?? null
}
