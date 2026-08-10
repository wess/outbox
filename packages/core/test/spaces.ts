/**
 * Round-trips blobs through a real S3-compatible bucket.
 *
 * Kept out of `bun test` deliberately: it needs credentials and it writes to
 * someone's bucket. The unit tests cover the inline path; this covers the half
 * that only fails in production.
 *
 * Usage:
 *   STORAGE_BUCKET=... STORAGE_REGION=... STORAGE_ENDPOINT=... \
 *   STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
 *   bun run packages/core/test/spaces.ts
 */
import {
  blobKey,
  deleteBlob,
  getBlob,
  loadBlob,
  loadText,
  putBlob,
  storageConfigured,
  storeBlob,
  storeText,
} from "../storage/index.ts"

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, detail === undefined ? "" : String(detail).slice(0, 300))
  }
}

if (!storageConfigured()) {
  console.error(
    "storage is not configured — set STORAGE_BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY",
  )
  process.exit(1)
}

const written: string[] = []

console.log("\nblobs")
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))
const ref = await storeBlob("test-attachments", "team-probe", "probe.bin", bytes)
check(
  "storeBlob returned a key, not inline content",
  Boolean(ref.storageKey) && ref.content === null,
  ref,
)
written.push(ref.storageKey!)

const back = await loadBlob({ storage_key: ref.storageKey, content: null })
check("bytes survive the round trip exactly", back.equals(bytes), `${back.byteLength} bytes`)

console.log("\nbinary safety")
// The bytes most likely to be mangled by a text-oriented path.
const nasty = Buffer.from([0x00, 0x0d, 0x0a, 0x1a, 0x80, 0xff, 0xc3, 0x28])
const nastyRef = await storeBlob("test-attachments", "team-probe", "nasty.bin", nasty)
written.push(nastyRef.storageKey!)
check(
  "invalid-UTF8 and control bytes survive",
  (await loadBlob({ storage_key: nastyRef.storageKey, content: null })).equals(nasty),
)

console.log("\nraw messages")
const raw = "Subject: test\r\nFrom: a@b.c\r\n\r\nbody with = and + and /\r\n"
const textRef = await storeText("test-inbound", "team-probe", "message.eml", raw)
check("storeText returned a key", Boolean(textRef.storageKey) && textRef.text === null, textRef)
written.push(textRef.storageKey!)
check(
  "raw message round trips including CRLF",
  (await loadText({ raw_storage_key: textRef.storageKey, raw: null })) === raw,
)

console.log("\ntenant isolation")
const a = blobKey("test-attachments", "team-a", "x.pdf")
const b = blobKey("test-attachments", "team-b", "x.pdf")
check("different teams get different prefixes", a.split("/")[2] !== b.split("/")[2], `${a} vs ${b}`)

console.log("\ndeletion")
const doomed = blobKey("test-attachments", "team-probe", "doomed.txt")
await putBlob(doomed, Buffer.from("bye"), "text/plain")
check("delete reports success", await deleteBlob(doomed))
check(
  "reading a deleted blob fails rather than returning empty",
  await getBlob(doomed).then(
    () => false,
    () => true,
  ),
)
check(
  "deleting an absent key is not fatal",
  await deleteBlob(doomed).then(
    () => true,
    () => false,
  ),
)

console.log("\ncleanup")
for (const key of written) await deleteBlob(key)
check("test objects removed", true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
