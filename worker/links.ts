/**
 * Store product addresses: which store, which product. Its own module so the
 * store adapters, the watchlist and the compare service can all read links
 * without importing each other.
 */

import { BASE as OTHOBA } from './othoba.ts'
import type { Listing } from './types.ts'

export interface ProductRef {
  site: Listing['site']
  itemId: string // as the agent keys it: Daraz's item id, "cartup:<id>"
  slug: string
  url: string
}

const DARAZ_PRODUCT = /daraz\.com\.bd\/products\/([^?#\s]*?)-i(\d+)(?:-s\d+)?\.html/i
const CARTUP_PRODUCT = /cartup\.com\/product\/([^?#\s/"'<>]+)/i
// Othoba's product pages sit at the top level, like its categories ("/fresh-fortified-soyebean-oil-5ltr-2");
// which one it is shows when the page is read (a category has no product data).
const OTHOBA_PAGE = /othoba\.com\/([a-z0-9][a-z0-9-]*)\/?(?=[?#\s"'<>]|$)/i

/** A Daraz, Cartup or Othoba product page's address, from a URL or the text an app shares ("I found this on Daraz! https://..."). */
export function readProductUrl(text: string): ProductRef | null {
  const d = DARAZ_PRODUCT.exec(text)
  if (d) return { site: 'daraz', itemId: d[2], slug: d[1], url: `https://www.daraz.com.bd/products/${d[1]}-i${d[2]}.html` }
  const c = CARTUP_PRODUCT.exec(text)
  if (c) {
    const slug = decodeURIComponent(c[1])
    const id = /[_-](\d{9,})[_-][a-z0-9]+$/.exec(slug)?.[1] ?? slug
    return { site: 'cartup', itemId: `cartup:${id}`, slug, url: `https://www.cartup.com/product/${slug}` }
  }
  const o = OTHOBA_PAGE.exec(text)
  if (o) return { site: 'othoba', itemId: `othoba-page:${o[1]}`, slug: o[1], url: `${OTHOBA}/${o[1]}` }
  return null
}
