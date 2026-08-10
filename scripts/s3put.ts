#!/usr/bin/env bun
/**
 * Streams stdin into the configured storage bucket.
 *
 * Outbox already holds S3 credentials for attachments, so the machinery to put
 * an object somewhere durable is present whether or not anything else on the
 * host has it. That makes shipping a database dump off the box a pipe rather
 * than a new dependency — which matters, because the moment blobs live in a
 * bucket, `pg_dump` on its own has stopped being a complete backup.
 *
 *   pg_dump -U outbox outbox | gzip | bun scripts/s3put.ts backups/db.sql.gz
 *
 * Reads the same STORAGE_* configuration as the rest of Outbox and writes
 * relative to STORAGE_PREFIX.
 */
import { putBlob, storageConfigured, storageSettings } from "../packages/core/storage/index.ts"

const key = process.argv[2]
if (!key) {
  console.error("usage: <something> | bun scripts/s3put.ts <key>")
  process.exit(1)
}

if (!storageConfigured()) {
  console.error(
    "no bucket configured — set STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY",
  )
  process.exit(1)
}

// Deliberately not blobKey(): that adds a uuid and slugs the filename, which is
// right for attachments and wrong for a backup, which wants the exact path it
// was asked for so yesterday's dump can be found by name. Only the prefix is
// shared.
const { prefix } = storageSettings()
const fullKey = `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}${key.replace(/^\/+/, "")}`

const bytes = new Uint8Array(await Bun.stdin.arrayBuffer())
if (bytes.byteLength === 0) {
  // A failed pg_dump upstream in the pipe exits non-zero but still closes
  // stdin, and uploading the resulting empty object would overwrite nothing
  // with nothing while reporting success.
  console.error("refusing to upload an empty object — did the command upstream fail?")
  process.exit(1)
}

await putBlob(fullKey, bytes, "application/octet-stream")
console.log(`${fullKey} (${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)`)
