/**
 * Pickaboo (pickaboo.com), an electronics and appliance retailer that sells
 * its own stock. Its search page (/search-result/<words>) carries the results
 * as data for its own app: name, address, regular and sale price, stock,
 * rating. Read from that page, the one a browser gets; no private API.
 */

import { normalizeListing } from './normalize.ts'
import type { Listing } from './types.ts'

const BASE = 'https://www.pickaboo.com'
const TIMEOUT_MS = 6000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

interface Product {
  id?: string
  product_name?: string
  slug?: string
  stock_available?: boolean
  coming_soon?: boolean
  product_price?: number
  product_specialPrice?: number | null
  rating?: string | null
  rating_count?: string | null
  product_img?: string
}

/** One search page -> its listings. The data sits in the page as escaped JSON, one flat object a product. */
export function parseSearchPage(html: string): Listing[] {
  const text = html.replace(/\\"/g, '"')
  const out: Listing[] = []
  for (const m of text.matchAll(/\{"id":"\d+"[^{}]*"product_name"[^{}]*\}/g)) {
    let p: Product
    try {
      p = JSON.parse(m[0]) as Product
    } catch {
      continue
    }
    const regular = Number(p.product_price)
    const special = Number(p.product_specialPrice)
    const price = special > 0 ? special : regular
    if (!p.id || !p.product_name || !p.slug || !(price > 0)) continue
    const original = regular > price ? regular : null
    const reviews = Number(p.rating_count) || 0
    out.push(
      normalizeListing({
        site: 'pickaboo',
        itemId: `pickaboo:${p.id}`,
        name: p.product_name.replace(/\s+/g, ' ').trim(),
        url: `${BASE}/product-detail/${p.slug}`,
        image: p.product_img ?? '',
        price,
        originalPrice: original,
        discountPercent: original ? Math.round(((original - price) / original) * 100) : null,
        seller: 'Pickaboo',
        brand: '',
        rating: reviews ? Number(p.rating) || null : null,
        reviews,
        sold: '',
        inStock: p.stock_available === true && p.coming_soon !== true,
        location: '',
        officialStore: false,
        storeRun: true,
        badges: [],
        highlights: [],
        relevance: 0,
        matchedFeatures: [],
      }),
    )
  }
  return [...new Map(out.map((l) => [l.itemId, l])).values()]
}

export async function search(query: string): Promise<Listing[]> {
  const response = await fetch(`${BASE}/search-result/${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  // Pickaboo answers a search with no results as a 404 page.
  if (response.status === 404) return []
  if (!response.ok) throw new Error(`Pickaboo search returned ${response.status}`)
  return parseSearchPage(await response.text())
}
