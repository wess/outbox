import { beforeAll, describe, expect, test } from "bun:test"
import {
  blobKey,
  configureStorage,
  loadBlob,
  loadText,
  storageConfigured,
  storeBlob,
  storeText,
  withRetry,
} from "../storage/index.ts"

// Set explicitly rather than assumed. These cases are about the inline fallback,
// and inheriting a real bucket from the developer's environment would silently
// turn them into something else — which is exactly what happened once.
beforeAll(() => {
  configureStorage({ bucket: "", accessKeyId: "", secretAccessKey: "", prefix: "outbox" })
})

// The inline path is what a fresh checkout runs, and what most self-hosters
// stay on.
describe("storage — unconfigured", () => {
  test("reports itself as not configured", () => {
    expect(storageConfigured()).toBe(false)
  })

  test("stores bytes inline as base64", async () => {
    const ref = await storeBlob("attachments", "team-1", "report.pdf", Buffer.from("hello"))
    expect(ref.storageKey).toBeNull()
    expect(ref.content).toBe(Buffer.from("hello").toString("base64"))
  })

  test("reads inline bytes back unchanged", async () => {
    const bytes = Buffer.from([0, 1, 250, 255, 13, 10])
    const ref = await storeBlob("attachments", "team-1", "x.bin", bytes)
    expect(await loadBlob({ content: ref.content, storage_key: null })).toEqual(bytes)
  })

  test("keeps raw text inline rather than base64", async () => {
    const ref = await storeText("inbound", "team-1", "message.eml", "Subject: hi\r\n\r\nbody")
    expect(ref.storageKey).toBeNull()
    expect(ref.text).toBe("Subject: hi\r\n\r\nbody")
    expect(await loadText({ raw: ref.text, raw_storage_key: null })).toBe("Subject: hi\r\n\r\nbody")
  })

  test("a missing attachment reads as empty rather than throwing", async () => {
    // Rows predating attachments, and rows where the column was never set.
    expect(await loadBlob({ content: null, storage_key: null })).toEqual(Buffer.alloc(0))
  })

  test("refuses to invent bytes for a key it cannot reach", async () => {
    // Silently returning empty here would deliver a zero-byte attachment, which
    // looks like success to everything downstream.
    expect(
      loadBlob({ content: null, storage_key: "outbox/attachments/t/x/y.pdf" }),
    ).rejects.toThrow(/no bucket is configured/)
  })
})

describe("blobKey", () => {
  test("namespaces by kind and team", () => {
    expect(blobKey("attachments", "team-1", "a.pdf")).toMatch(
      /^outbox\/attachments\/team-1\/[0-9a-f-]{36}\/a\.pdf$/,
    )
  })

  test("two calls never collide on the same filename", () => {
    expect(blobKey("attachments", "t", "a.pdf")).not.toBe(blobKey("attachments", "t", "a.pdf"))
  })

  test("strips path traversal and separators out of the filename", () => {
    // A filename arrives from whoever sent the mail. Left alone, `../` would
    // walk the key out of its team's prefix and into another tenant's.
    const key = blobKey("attachments", "team-1", "../../etc/passwd")
    expect(key).toMatch(/^outbox\/attachments\/team-1\/[0-9a-f-]{36}\/[^/]+$/)
    expect(key).not.toContain("..")
  })

  test("survives a filename with no usable characters", () => {
    expect(blobKey("attachments", "t", "///")).toMatch(/\/file$/)
  })

  test("truncates a very long filename", () => {
    const key = blobKey("attachments", "t", `${"a".repeat(500)}.pdf`)
    expect(key.split("/").pop()!.length).toBeLessThanOrEqual(80)
  })

  test("keeps unicode out of the key without dropping the name entirely", () => {
    // A run of non-ASCII collapses to one dash, so `réçu` becomes `r-u`.
    expect(blobKey("attachments", "t", "réçu-2026.pdf")).toMatch(/\/r-u-2026\.pdf$/)
  })
})

describe("retry", () => {
  test("a transient failure does not surface to the caller", async () => {
    // A ConnectionClosed on the first request of a process is the failure this
    // exists for; without a retry it rejects an otherwise-fine send.
    let calls = 0
    const flaky = async () => {
      calls++
      if (calls < 3) throw new Error("ConnectionClosed")
      return "ok"
    }
    expect(await withRetry("probe", flaky)).toBe("ok")
    expect(calls).toBe(3)
  })

  test("a persistent failure still fails, with the original error", async () => {
    let calls = 0
    const dead = async () => {
      calls++
      throw new Error("NoSuchBucket")
    }
    expect(withRetry("probe", dead)).rejects.toThrow("NoSuchBucket")
    expect(calls).toBe(3)
  })
})
