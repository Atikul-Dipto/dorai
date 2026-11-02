/**
 * Othoba as an agent tool, searched live like Daraz: Othoba's own search
 * page (/search?q= → /ts/search/...) is rendered on its server, so its
 * results (product id, address, name, in Othoba's order) are in the HTML.
 * robots.txt asks robots not to use it; the owner decided DorAI does, at one
 * page per question (2026-11-03). Prices aren't in those results, so each
 * candidate's product page gives the live price, stock and seller from its
 * schema.org Product data. The page's search key is deliberately hidden and
 * is not used.
 *
 * When the search page can't be read, the name index built from Othoba's
 * category pages (../agent/othoba_index.py, othoba_* tables) answers instead.
 *
 * Only a handful of pages are fetched per question (MAX_PAGES), never a crawl.
 */

import { type CartupLookup, searchIndex } from './cartup.ts'
import { decodeEntities, normalizeListing } from './normalize.ts'
import { foundWords, tokens } from './ranking.ts'
import type { D1Database, Listing } from './types.ts'

const MAX_PAGES = 4
const TIMEOUT_MS = 6000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
export const BASE = 'https://othoba.com'

type LdOffer = { price?: string | number; sale_price?: string | number; availability?: string; seller?: string }
type LdProduct = { '@type'?: string; name?: string; image?: string | string[]; id?: string; brand?: string; offers?: LdOffer; custom_label_0?: string }

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN)

/** One Othoba product page -> Listing, from its schema.org Product data and what the page shows. */
export function parseProductPage(html: string, slug: string): Listing | null {
  let product: LdProduct | undefined
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]) as LdProduct
      if (data['@type'] === 'Product') product = data
    } catch {
      // not JSON: skip
    }
  }
  // "price" is the regular price; "sale_price" is what it sells for now
  // (the Proton RE-Turbo: price 1150, sale_price 1035, shown as Tk 1,035).
  const regular = Number(product?.offers?.price)
  const sale = Number(product?.offers?.sale_price)
  const price = Number.isFinite(sale) && sale > 0 && (!Number.isFinite(regular) || sale < regular) ? sale : regular
  if (!product || !Number.isFinite(price) || price <= 0) return null
  const old = Math.max(0, ...[regular, num(/class="old-price[^"]*"[^>]*>\s*(?:<span[^>]*>\s*)?(?:৳|Tk\.?)?\s*([\d,.]+)/i.exec(html)?.[1])].filter((v) => Number.isFinite(v)))
  // An app-only price, shown on the page but not sold on the website.
  const app = num(/class="app-glass-price"[^>]*>\s*(?:৳|Tk\.?)?\s*([\d,.]+)/i.exec(html)?.[1])
  const reviews = Number(/([\d,]+)\s*review\(s\)/i.exec(html)?.[1]?.replace(/,/g, '') ?? 0)
  const width = num(/class="ratings"\s+style="width:\s*([\d.]+)%/i.exec(html)?.[1])
  const original = Number.isFinite(old) && old > price ? old : null
  return normalizeListing({
    site: 'othoba',
    itemId: `othoba:${product.id ?? slug}`,
    name: String(product.name ?? slug),
    url: `${BASE}/${slug}`,
    image: (Array.isArray(product.image) ? product.image[0] : product.image) ?? '',
    price,
    originalPrice: original,
    discountPercent: original ? Math.round(((original - price) / original) * 100) : null,
    seller: String(product.offers?.seller ?? product.custom_label_0 ?? ''),
    brand: String(product.brand ?? ''),
    rating: reviews > 0 && Number.isFinite(width) ? Math.round(width / 2) / 10 : null,
    reviews,
    sold: '',
    inStock: String(product.offers?.availability ?? '').endsWith('InStock'),
    location: '',
    officialStore: false,
    badges: [],
    highlights: Number.isFinite(app) && app < price ? [`App-only price ৳${app} in Othoba's app`] : [],
    relevance: 0,
    matchedFeatures: [],
  })
}

export async function fetchProduct(slug: string): Promise<Listing | null> {
  const response = await fetch(`${BASE}/${slug}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) return null
  return parseProductPage(await response.text(), slug)
}

export interface SearchHit {
  id: string
  slug: string
  name: string
}

// A result card: its product id, then the product's address and name in its heading.
const HIT_RE = /data-productid="(\d+)"[\s\S]*?<h4 class="product-name">\s*<a href="\/([a-z0-9][a-z0-9-]*)"[^>]*>([\s\S]*?)<\/a>/g

/** Othoba's search results page -> its hits, in Othoba's order, each once. */
export function parseSearchPage(html: string): SearchHit[] {
  const hits = new Map<string, SearchHit>()
  for (const [, id, slug, name] of html.matchAll(HIT_RE)) {
    if (!hits.has(id)) hits.set(id, { id, slug, name: decodeEntities(name.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() })
  }
  return [...hits.values()]
}

export async function search(query: string): Promise<SearchHit[]> {
  const response = await fetch(`${BASE}/search?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Othoba search returned ${response.status}`)
  return parseSearchPage(await response.text())
}

/**
 * Which hits' product pages to read: the ones whose names hold most of the
 * title's words (a seller's long title is searched as typed, and Othoba
 * ranks loosely), Othoba's own order breaking ties.
 */
export function bestHits(hits: SearchHit[], title: string, limit = MAX_PAGES): SearchHit[] {
  const want = [...new Set(tokens(title))]
  const score = (h: SearchHit) => foundWords(want, h.name).length / (want.length || 1)
  return hits
    .map((h, i) => ({ h, i, s: score(h) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.h)
}

const readPages = async (slugs: string[]) => (await Promise.all(slugs.map((s) => fetchProduct(s).catch(() => null)))).filter((l): l is Listing => l !== null)

/** Othoba listings for a product title: its live search first, its name index if that fails. */
export async function lookup(db: D1Database | undefined, title: string): Promise<CartupLookup> {
  const hits = await search(title).catch(() => null)
  if (hits?.length) {
    const listings = await readPages(bestHits(hits, title).map((h) => h.slug))
    if (listings.length) return { status: 'found', listings, indexedAt: null }
  }
  if (!db) return { status: hits ? 'not_found' : 'error', listings: [], indexedAt: null }
  try {
    const { slugs, meta } = await searchIndex(db, title, 'othoba')
    if (!meta) return { status: hits ? 'not_found' : 'no_index', listings: [], indexedAt: null }
    const listings = await readPages(slugs.slice(0, MAX_PAGES))
    return { status: listings.length ? 'found' : 'not_found', listings, indexedAt: meta.built }
  } catch {
    return { status: 'error', listings: [], indexedAt: null }
  }
}
