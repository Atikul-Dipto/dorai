/**
 * Data normalization: every store's listing leaves its adapter in one shape,
 * whatever the store wrote. Names without HTML entities or stray spacing,
 * prices as plain numbers, an original price only when it is really higher,
 * the discount computed from the two (never parsed from a "50% Off" label),
 * and absolute https image links.
 */

import type { Listing } from './types.ts'

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }

export const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ''), /^#x/i.test(e) ? 16 : 10)) : (ENTITIES[e.toLowerCase()] ?? m),
  )

export const cleanText = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim()

const cents = (n: number) => Math.round(n * 100) / 100

export function normalizeListing(l: Listing): Listing {
  const price = cents(l.price)
  const original = l.originalPrice != null && Number.isFinite(l.originalPrice) && l.originalPrice > price ? cents(l.originalPrice) : null
  return {
    ...l,
    name: cleanText(l.name),
    seller: cleanText(l.seller),
    brand: cleanText(l.brand),
    image: l.image.startsWith('//') ? `https:${l.image}` : l.image,
    price,
    originalPrice: original,
    discountPercent: original ? Math.round(((original - price) / original) * 100) : null,
    ...(l.alsoNamed && { alsoNamed: cleanText(l.alsoNamed) }),
  }
}
