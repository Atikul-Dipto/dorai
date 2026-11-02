// Offline tests for the store adapters and data normalization — fetch is replaced, so no network.
//   node --test worker/stores.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeListing } from './normalize.ts'
import { lookup as othobaLookup, parseSearchPage } from './othoba.ts'
import { STORES } from './stores.ts'
import type { Listing } from './types.ts'

const raw = (extra: Partial<Listing>): Listing => ({
  site: 'othoba',
  itemId: 'othoba:1',
  name: 'x',
  url: 'https://othoba.com/x',
  image: '',
  price: 100,
  originalPrice: null,
  discountPercent: null,
  seller: '',
  brand: '',
  rating: null,
  reviews: 0,
  sold: '',
  inStock: true,
  location: '',
  officialStore: false,
  badges: [],
  highlights: [],
  relevance: 0,
  matchedFeatures: [],
  ...extra,
})

test('every listing leaves its store in one shape', () => {
  const l = normalizeListing(raw({ name: '  Tom &amp; Jerry   Mug&nbsp;350ml ', seller: ' Shop\n A ', image: '//img.example/p/a.jpg', price: 199.999, originalPrice: 250, discountPercent: 90 }))
  assert.equal(l.name, 'Tom & Jerry Mug 350ml')
  assert.equal(l.seller, 'Shop A')
  assert.equal(l.image, 'https://img.example/p/a.jpg')
  assert.equal(l.price, 200)
  // The discount is computed from the two prices, never taken from a label.
  assert.equal(l.discountPercent, 20)
  // An "original" price that isn't higher is no discount at all.
  assert.equal(normalizeListing(raw({ price: 100, originalPrice: 100 })).originalPrice, null)
})

test("a store adapter reads one product's current listing again", async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://www.daraz.com.bd/catalog')) {
      const q = new URL(url).searchParams.get('q')
      // Only the brand + model code search lists this seller.
      const items = q === 'Hoco EQ34' ? [{ itemId: '111', name: 'Hoco EQ34 Plus Rima TWS Earbuds', price: '799', itemUrl: '//www.daraz.com.bd/products/x-i111.html' }] : []
      return Response.json({ mods: { listItems: items } })
    }
    if (url.startsWith('https://othoba.com/')) {
      const ld = { '@type': 'Product', name: 'Fresh Soybean Oil 5ltr', id: '9', offers: { price: '1000', availability: 'http://schema.org/InStock' } }
      return new Response(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const daraz = await STORES.daraz.current({ itemId: '111', url: 'https://www.daraz.com.bd/products/x-i111.html', name: 'Hoco EQ34 Plus Rima TWS Earbuds' }, {})
    assert.equal(daraz?.price, 799)
    const othoba = await STORES.othoba.current({ itemId: 'othoba:9', url: 'https://othoba.com/fresh-soybean-oil-5ltr', name: 'Fresh Soybean Oil 5ltr' }, {})
    assert.equal(othoba?.price, 1000)
    // An address of the wrong store is not that store's product.
    assert.equal(await STORES.cartup.current({ itemId: 'cartup:1', url: 'https://othoba.com/x', name: 'x' }, {}), null)
  } finally {
    globalThis.fetch = real
  }
})

// Othoba's search page, as it renders a result card (trimmed): the id, then the address and name in its heading.
const card = (id: string, slug: string, name: string) =>
  `<div class="product-wrap" data-productid="${id}"><figure><a href="/${slug}"><img alt="${name}" /></a></figure>` +
  `<div class="product-details"><h4 class="product-name"> <a href="/${slug}"> ${name} </a> </h4></div></div>`

test("Othoba's live search: its results, best-named first, then their product pages", async () => {
  const page = [
    card('725146', 'awei-t50-tws-wireless-gaming-earbuds-725146', 'Awei T50 TWS Wireless Gaming Earbuds'),
    card('826386', 'awei-t50-wireless-headphones-bluetooth-53-earbuds-with-mic-ekclick-826386', 'Awei T50 Wireless Headphones Bluetooth 5.3 Earbuds With Mic'),
    card('725146', 'awei-t50-tws-wireless-gaming-earbuds-725146', 'Awei T50 TWS Wireless Gaming Earbuds'),
  ].join('')
  assert.deepEqual(parseSearchPage(page).map((h) => h.id), ['725146', '826386'])

  const real = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    if (url.startsWith('https://othoba.com/search?q=')) return new Response(page)
    const id = /-(\d+)$/.exec(url)?.[1]
    const ld = { '@type': 'Product', name: id === '826386' ? 'Awei T50 Wireless Headphones Bluetooth 5.3 Earbuds With Mic' : 'Awei T50 TWS Wireless Gaming Earbuds', id, offers: { price: '1250', availability: 'http://schema.org/InStock' } }
    return new Response(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)
  }) as typeof fetch
  try {
    const found = await othobaLookup(undefined, 'Awei T50 Wireless Headphones Bluetooth 5.3 Earbuds With Mic')
    assert.equal(found.status, 'found')
    // The exact title's listing is read first, though Othoba listed it second.
    assert.equal(found.listings[0].itemId, 'othoba:826386')
    assert.equal(asked[0], 'https://othoba.com/search?q=Awei%20T50%20Wireless%20Headphones%20Bluetooth%205.3%20Earbuds%20With%20Mic')
  } finally {
    globalThis.fetch = real
  }
})
