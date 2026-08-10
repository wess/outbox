/**
 * Sends a real email with attachments through a running Outbox and checks that
 * the bytes went to object storage, came back intact, and reached the wire.
 *
 * The unit tests cover the storage module in isolation and `spaces.ts` covers
 * the bucket. This covers the part neither can: that the send path, the
 * database, the API and the worker agree about where a blob lives.
 *
 * Usage: OUTBOX_API_KEY=ob_... bun run packages/core/test/attachments.ts
 */
import { closeDb, db } from "../db/index.ts"
import { getBlob, storageConfigured } from "../storage/index.ts"

const BASE = process.env.OUTBOX_BASE ?? "http://localhost:3000"
const KEY = process.env.OUTBOX_API_KEY
if (!KEY) {
  console.error("set OUTBOX_API_KEY")
  process.exit(1)
}

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const call = async (method: string, path: string, body?: unknown): Promise<any> => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "user-agent": "outbox-attachment-test/1.0",
        authorization: `Bearer ${KEY}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    if (res.status === 429 && attempt < 20) {
      await sleep(1100)
      continue
    }
    return { status: res.status, body: parsed }
  }
}

console.log(`storage configured: ${storageConfigured()}`)

console.log("\nsetup")
const stamp = Date.now()
const domainName = `attach-${stamp}.test`
const domain = await call("POST", "/domains", { name: domainName })
check("domain created", domain.status === 201, domain.body)

// Bytes chosen to break anything that treats attachments as text.
const pdf = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256)),
  Buffer.from("\n%%EOF\n"),
])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28])

console.log("\nsend with attachments")
const sent = await call("POST", "/emails", {
  from: `Acme <hi@${domainName}>`,
  to: ["someone@example.com"],
  subject: "With attachments",
  text: "see attached",
  attachments: [
    { filename: "report.pdf", content: pdf.toString("base64"), content_type: "application/pdf" },
    { filename: "logo.png", content: png.toString("base64"), content_type: "image/png" },
  ],
})
check("email accepted", sent.status === 200, sent.body)
const emailId = sent.body.id

console.log("\nwhere the bytes went")
const rows = await db().all<{
  filename: string
  size: number
  content: string | null
  storage_key: string | null
}>({
  text: "SELECT filename, size, content, storage_key FROM email_attachments WHERE email_id = $1 ORDER BY filename",
  values: [emailId],
})
check("both attachments recorded", rows.length === 2, rows.length)

const logo = rows.find((r) => r.filename === "logo.png")
const report = rows.find((r) => r.filename === "report.pdf")

if (storageConfigured()) {
  check("pdf has a storage key", Boolean(report?.storage_key), report?.storage_key)
  check("pdf content column is empty", report?.content === null, report?.content?.slice(0, 40))
  check(
    "storage key is namespaced under attachments",
    report?.storage_key?.includes("/attachments/") === true,
    report?.storage_key,
  )
  check(
    "object in the bucket matches what was sent",
    (await getBlob(report!.storage_key!)).equals(pdf),
  )
  check("png also round trips", (await getBlob(logo!.storage_key!)).equals(png))
} else {
  check("pdf stored inline when no bucket is configured", Boolean(report?.content))
}

check("recorded size is the decoded byte length", report?.size === pdf.byteLength, {
  recorded: report?.size,
  actual: pdf.byteLength,
})

console.log("\nreading it back through the API")
const list = await call("GET", `/emails/${emailId}/attachments`)
check("attachments list returns both", list.body.data?.length === 2, list.body)

const listed = list.body.data.find((a: any) => a.filename === "report.pdf")
const fetched = await call("GET", `/emails/${emailId}/attachments/${listed.id}`)
check("attachment fetch succeeds", fetched.status === 200, fetched.body)
check(
  "API returns the original bytes as base64",
  Buffer.from(fetched.body.content ?? "", "base64").equals(pdf),
  `${Buffer.from(fetched.body.content ?? "", "base64").byteLength} bytes`,
)

console.log("\ndelivery")
const delivered = await (async () => {
  for (let i = 0; i < 40; i++) {
    const r = await call("GET", `/emails/${emailId}`)
    if (r.body.last_event === "delivered") return r.body
    await sleep(500)
  }
  return null
})()
check("worker delivered it", Boolean(delivered), delivered)
// A worker that cannot read the blob fails the job, so reaching `delivered`
// with attachments in a bucket is itself the assertion that the read path works
// on the delivery side.
check("delivery did not fall back to an error", delivered?.last_event === "delivered", delivered)

console.log("\ncleanup")
await call("DELETE", `/domains/${domain.body.id}`)
await closeDb()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
