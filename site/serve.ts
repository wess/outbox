#!/usr/bin/env bun
/**
 * Local preview for the built docs.
 *
 *   bun run site/build.ts && bun run site/serve.ts
 */
import { join } from "node:path"

const ROOT = join(import.meta.dir, "public")
// Not PORT — Bun auto-loads the repo's .env, where PORT belongs to the app.
const PORT = Number(process.env.DOCS_PORT ?? 4321)

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
}

const contentType = (path: string): string => {
  const dot = path.lastIndexOf(".")
  return TYPES[path.slice(dot)] ?? "application/octet-stream"
}

const server = Bun.serve({
  port: PORT,
  fetch: async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname)

    // Clean URLs: /api/emails -> /api/emails/index.html
    for (const candidate of [
      path.endsWith("/") ? `${path}index.html` : path,
      `${path}/index.html`.replace(/\/+/g, "/"),
    ]) {
      const file = Bun.file(join(ROOT, candidate))
      if (await file.exists()) {
        return new Response(file, { headers: { "content-type": contentType(candidate) } })
      }
    }

    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } })
  },
})

console.log(`docs preview on http://localhost:${server.port}`)
