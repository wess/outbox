#!/usr/bin/env bun
/**
 * Static site generator for the Outbox documentation.
 *
 * Reads `site/content/**\/*.md`, renders each page into the shared layout, and
 * writes `site/public/`. Also emits `llms.txt` and `llms-full.txt` so an agent
 * can consume the docs without scraping HTML.
 *
 *   bun run site/build.ts [--base /outbox]
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import hljs from "highlight.js"
import { marked } from "marked"

const ROOT = dirname(new URL(import.meta.url).pathname)
const CONTENT = join(ROOT, "content")
const OUT = join(ROOT, "public")

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

// GitHub Pages serves project sites under /<repo>, so every link needs the prefix.
const BASE = (arg("--base") ?? process.env.SITE_BASE ?? "").replace(/\/$/, "")
// A trailing slash would double up against every page path below.
const SITE_URL = (process.env.SITE_URL ?? "https://wess.github.io/outbox").replace(/\/$/, "")

// ------------------------------------------------------------- front matter --

type Page = {
  slug: string
  url: string
  title: string
  description: string
  section: string
  order: number
  markdown: string
  html: string
  headings: { id: string; text: string; level: number }[]
}

const parseFrontMatter = (raw: string): { meta: Record<string, string>; body: string } => {
  if (!raw.startsWith("---")) return { meta: {}, body: raw }
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  for (const line of raw.slice(3, end).split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1")
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, "") }
}

// ---------------------------------------------------------------- rendering --

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const renderMarkdown = (markdown: string): { html: string; headings: Page["headings"] } => {
  const headings: Page["headings"] = []
  const seen = new Map<string, number>()

  const renderer = new marked.Renderer()

  renderer.heading = ({ text, depth }) => {
    const plain = text.replace(/<[^>]+>/g, "")
    let id = slugify(plain)
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    if (count > 0) id = `${id}-${count}`
    if (depth === 2 || depth === 3) headings.push({ id, text: plain, level: depth })
    return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`
  }

  renderer.code = ({ text, lang }) => {
    const language = (lang ?? "").split(/\s+/)[0] ?? ""
    const supported = language && hljs.getLanguage(language)
    const body = supported ? hljs.highlight(text, { language }).value : escapeHtml(text)
    const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : ""
    return `<div class="code-block">${label}<button class="copy" type="button" aria-label="Copy code">Copy</button><pre><code class="hljs language-${escapeHtml(language)}">${body}</code></pre></div>\n`
  }

  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens)
    // Internal .md links become clean URLs under the base path.
    let target = href
    if (/^\.?\/?[\w./-]+\.md(#.*)?$/.test(href)) {
      target = `${BASE}/${href.replace(/^\.?\//, "").replace(/\.md/, "")}`.replace(/\/index$/, "/")
    } else if (href.startsWith("/") && !href.startsWith("//")) {
      target = `${BASE}${href}`
    }
    const external = /^https?:\/\//.test(target)
    const attrs = external ? ' target="_blank" rel="noreferrer noopener"' : ""
    return `<a href="${target}"${title ? ` title="${title}"` : ""}${attrs}>${text}</a>`
  }

  renderer.table = ({ header, rows }) => {
    const head = header.map((c) => `<th>${renderer.parser.parseInline(c.tokens)}</th>`).join("")
    const body = rows
      .map(
        (row) =>
          `<tr>${row.map((c) => `<td>${renderer.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`,
      )
      .join("")
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`
  }

  const html = marked.parse(markdown, { renderer, async: false }) as string
  return { html, headings }
}

// --------------------------------------------------------------- navigation --

type NavGroup = { title: string; items: { title: string; url: string; slug: string }[] }

const SECTION_ORDER = ["Getting started", "Tutorials", "API reference", "Reference"]

const buildNav = (pages: Page[]): NavGroup[] => {
  const groups = new Map<string, Page[]>()
  for (const page of pages) {
    const list = groups.get(page.section) ?? []
    list.push(page)
    groups.set(page.section, list)
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a[0])
      const bi = SECTION_ORDER.indexOf(b[0])
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
    .map(([title, list]) => ({
      title,
      items: list
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
        .map((p) => ({ title: p.title, url: p.url, slug: p.slug })),
    }))
}

// ------------------------------------------------------------------ layout --

const layout = (input: { page: Page; nav: NavGroup[]; css: string }): string => {
  const { page, nav, css } = input

  const navHtml = nav
    .map(
      (group) => `<div class="nav-group">
        <div class="nav-title">${group.title}</div>
        ${group.items
          .map(
            (item) =>
              `<a class="nav-link${item.slug === page.slug ? " active" : ""}" href="${item.url}">${item.title}</a>`,
          )
          .join("\n")}
      </div>`,
    )
    .join("\n")

  const toc = page.headings.length
    ? `<aside class="toc">
        <div class="toc-title">On this page</div>
        ${page.headings
          .map((h) => `<a class="toc-link level-${h.level}" href="#${h.id}">${h.text}</a>`)
          .join("\n")}
      </aside>`
    : ""

  const canonical = `${SITE_URL}${page.url.replace(BASE, "")}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<title>${escapeHtml(page.title)} · Outbox</title>
<meta name="description" content="${escapeHtml(page.description)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:title" content="${escapeHtml(page.title)} · Outbox" />
<meta property="og:description" content="${escapeHtml(page.description)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${canonical}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📨</text></svg>" />
<style>${css}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <a class="brand" href="${BASE}/">📨 <strong>Outbox</strong></a>
  <button class="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false">Menu</button>
  <nav class="topnav">
    <a href="${BASE}/quickstart">Quickstart</a>
    <a href="${BASE}/api/introduction">API</a>
    <a href="${BASE}/tutorials/send-your-first-email">Tutorials</a>
    <a href="${BASE}/llms.txt">llms.txt</a>
    <a href="https://github.com/wess/outbox" target="_blank" rel="noreferrer noopener">GitHub</a>
  </nav>
</header>

<div class="shell">
  <nav class="sidebar" id="sidebar">${navHtml}</nav>
  <main id="main" class="content">
    <article class="prose">${page.html}</article>
    <footer class="page-footer">
      <a href="https://github.com/wess/outbox/edit/main/site/content/${page.slug}.md" target="_blank" rel="noreferrer noopener">Edit this page</a>
      <span>MIT licensed · Not affiliated with Resend</span>
    </footer>
  </main>
  ${toc}
</div>

<script>
document.querySelector(".menu-toggle")?.addEventListener("click", (e) => {
  const sidebar = document.getElementById("sidebar")
  const open = sidebar.classList.toggle("open")
  e.currentTarget.setAttribute("aria-expanded", String(open))
})
for (const button of document.querySelectorAll(".code-block .copy")) {
  button.addEventListener("click", async () => {
    const code = button.parentElement.querySelector("code")
    try { await navigator.clipboard.writeText(code.innerText) } catch {}
    const original = button.textContent
    button.textContent = "Copied"
    setTimeout(() => { button.textContent = original }, 1400)
  })
}
</script>
</body>
</html>
`
}

// -------------------------------------------------------------------- main --

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (entry.name.endsWith(".md")) files.push(full)
  }
  return files
}

const build = async () => {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const css = await readFile(join(ROOT, "theme", "styles.css"), "utf8")
  const hljsCss = await readFile(join(ROOT, "theme", "code.css"), "utf8")
  const allCss = `${css}\n${hljsCss}`

  const files = (await walk(CONTENT)).sort()
  const pages: Page[] = []

  for (const file of files) {
    const raw = await readFile(file, "utf8")
    const { meta, body } = parseFrontMatter(raw)
    const slug = relative(CONTENT, file).replace(/\.md$/, "")
    const url = slug === "index" ? `${BASE}/` : `${BASE}/${slug}`
    const { html, headings } = renderMarkdown(body)

    pages.push({
      slug,
      url,
      title: meta.title ?? slug,
      description: meta.description ?? "",
      section: meta.section ?? "Reference",
      order: Number(meta.order ?? 999),
      markdown: body,
      html,
      headings,
    })
  }

  const nav = buildNav(pages.filter((p) => p.slug !== "index"))

  for (const page of pages) {
    const target =
      page.slug === "index" ? join(OUT, "index.html") : join(OUT, page.slug, "index.html")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, layout({ page, nav, css: allCss }))
  }

  // ------------------------------------------------------------- llms.txt --
  // Same convention Resend and other docs sites use: a linked index an agent
  // can fetch first, plus a single-file dump of everything.
  const bySection = new Map<string, Page[]>()
  for (const page of pages) {
    if (page.slug === "index") continue
    const list = bySection.get(page.section) ?? []
    list.push(page)
    bySection.set(page.section, list)
  }

  const llms = [
    "# Outbox",
    "",
    "> Open source email API and dashboard — a self-hostable Resend. Outbox implements the Resend API surface (same paths, request bodies, response shapes, and error envelope), so any Resend SDK works against it by changing only the base URL. Built on Bun, Atlas, and PostgreSQL. MIT licensed.",
    "",
    `The complete documentation in one file: [llms-full.txt](${SITE_URL}/llms-full.txt)`,
    "",
    ...[...bySection.entries()]
      .sort((a, b) => {
        const ai = SECTION_ORDER.indexOf(a[0])
        const bi = SECTION_ORDER.indexOf(b[0])
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
      .flatMap(([section, list]) => [
        `## ${section}`,
        "",
        ...list
          .sort((a, b) => a.order - b.order)
          .map((p) => `- [${p.title}](${SITE_URL}/${p.slug}.md): ${p.description}`),
        "",
      ]),
    "## Source",
    "",
    "- [Repository](https://github.com/wess/outbox): source, issues, and releases",
    "",
  ].join("\n")
  await writeFile(join(OUT, "llms.txt"), llms)

  const full = [
    "# Outbox — complete documentation",
    "",
    "> Open source email API and dashboard. A self-hostable Resend.",
    `> Generated from ${SITE_URL}`,
    "",
    ...pages
      .sort((a, b) => {
        const ai = SECTION_ORDER.indexOf(a.section)
        const bi = SECTION_ORDER.indexOf(b.section)
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.order - b.order
      })
      .flatMap((p) => [`\n\n---\n\n# ${p.title}\n`, `> ${p.description}\n`, p.markdown]),
  ].join("\n")
  await writeFile(join(OUT, "llms-full.txt"), full)

  // Raw markdown alongside each page, so `<url>.md` works like Resend's docs.
  for (const page of pages) {
    if (page.slug === "index") continue
    const target = join(OUT, `${page.slug}.md`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `# ${page.title}\n\n> ${page.description}\n\n${page.markdown}`)
  }

  // GitHub Pages would otherwise run Jekyll and drop files beginning with _.
  await writeFile(join(OUT, ".nojekyll"), "")

  const urls = pages
    .map((p) => `  <url><loc>${SITE_URL}${p.url.replace(BASE, "") || "/"}</loc></url>`)
    .join("\n")
  await writeFile(
    join(OUT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  )
  await writeFile(
    join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`,
  )

  console.log(`built ${pages.length} pages -> ${relative(process.cwd(), OUT)}`)
  console.log(`  llms.txt, llms-full.txt, sitemap.xml, robots.txt`)
}

await build()
