/**
 * Cartup's section (category) list, from its public category sitemap, written
 * to worker/cartupSections.ts: the copy the site falls back to when its
 * database (cartup_meta, refreshed by agent/cartup_index.py) can't be read.
 *
 *   node scripts/cartup-sections.mjs
 *
 * Cartup's sitemaps still link to www.cartup.com, which answers 404 to
 * everything since 2026-11-11; the links are read at cartup.com instead.
 */

import { writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const atCartup = (url) => url.replace('://www.cartup.com', '://cartup.com')

async function read(url) {
  const response = await fetch(atCartup(url), { headers: { 'user-agent': UA } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  try {
    return gunzipSync(bytes).toString()
  } catch {
    return bytes.toString()
  }
}

const index = await read('https://cartup.com/sitemap-category-all.xml.gz')
const slugs = new Set()
for (const [, url] of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
  const xml = await read(url)
  for (const [, slug] of xml.matchAll(/\/category\/([^<\s/?#]+)<\/loc>/g)) slugs.add(slug)
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
const list = [...slugs].sort()
if (list.length < 1000) throw new Error(`Only ${list.length} sections read; Cartup's sitemap has changed.`)
const today = new Date().toISOString().slice(0, 10)
writeFileSync(
  new URL('../worker/cartupSections.ts', import.meta.url),
  `// Written by scripts/cartup-sections.mjs from Cartup's category sitemap on ${today}: ${list.length} sections.\n` +
    `// The copy the site falls back to when its database (cartup_meta) can't be read. Don't edit by hand.\n` +
    `export const SECTIONS: string[] = ${JSON.stringify(list)}\n`,
)
console.log(`${list.length} sections -> worker/cartupSections.ts`)
