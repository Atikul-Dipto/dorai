/**
 * Star Tech (startech.com.bd), an electronics retailer that sells its own
 * stock. Its search page lists each result's name, link, photo and price in
 * the page itself (20 a page), read here the way a browser shows them.
 */

import { normalizeListing } from './normalize.ts'
import type { Listing } from './types.ts'

const BASE = 'https://www.startech.com.bd'
const TIMEOUT_MS = 6000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
const taka = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : NaN)

/** One search page -> its listings. A result with no price ("Up Coming", "Call for Price") isn't one. */
export function parseSearchPage(html: string): Listing[] {
  const out: Listing[] = []
  for (const block of html.split('<div class="p-item">').slice(1)) {
    const link = /<h4 class="p-item-name">\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(block)
    const priceBox = /<div class="p-item-price">([\s\S]*?)<\/div>/.exec(block)?.[1] ?? ''
    const price = taka(/<span class="price-new">([\d,]+)৳/.exec(priceBox)?.[1] ?? /<span>([\d,]+)৳<\/span>/.exec(priceBox)?.[1])
    if (!link || !Number.isFinite(price) || price <= 0) continue
    const old = taka(/<span class="price-old">([\d,]+)৳/.exec(priceBox)?.[1])
    const url = link[1].split('?')[0]
    const original = Number.isFinite(old) && old > price ? old : null
    out.push(
      normalizeListing({
        site: 'startech',
        itemId: `startech:${url.replace(BASE, '').replace(/^\/+/, '')}`,
        name: decode(link[2]),
        url,
        image: /<img src="([^"]+)"/.exec(block)?.[1] ?? '',
        price,
        originalPrice: original,
        discountPercent: original ? Math.round(((original - price) / original) * 100) : null,
        seller: 'Star Tech',
        brand: '',
        rating: null,
        reviews: 0,
        sold: '',
        inStock: !/out of stock/i.test(priceBox),
        location: '',
        officialStore: false,
        storeRun: true,
        badges: [],
        highlights: [...block.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => decode(m[1])).slice(0, 6),
        relevance: 0,
        matchedFeatures: [],
      }),
    )
  }
  return out
}

export async function search(query: string): Promise<Listing[]> {
  const response = await fetch(`${BASE}/product/search?search=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Star Tech search returned ${response.status}`)
  return parseSearchPage(await response.text())
}
