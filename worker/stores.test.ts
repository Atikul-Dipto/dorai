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

// ---- Star Tech and Pickaboo, read from the markup their pages use (2026-11-07) ----
import { parseSearchPage as parseStartech } from './startech.ts'
import { parseSearchPage as parsePickaboo } from './pickaboo.ts'
import { segmentOf, shopsFor } from './segments.ts'

test('Star Tech: name, link, sale and old price, stock; a result with no price is left out', () => {
  const item = (name: string, slug: string, price: string) =>
    `<div class="p-item"> <div class="p-item-inner"> <div class="p-item-img"><a href="https://www.startech.com.bd/${slug}"><img src="https://www.startech.com.bd/image/${slug}.webp" alt="${name}"></a></div> <div class="p-item-details"> <h4 class="p-item-name"> <a href="https://www.startech.com.bd/${slug}">${name} </a></h4> <div class="short-description"> <ul><li>Connectivity: Wired </li></ul> </div> <div class="p-item-price"> ${price} </div></div></div></div>`
  const html =
    item('Logitech K120 USB Keyboard With Bangla', 'logitech-k120-keyboard', '<span>845৳</span>') +
    item('Fantech X9 Thor Gaming Mouse', 'fantech-x9', '<span class="price-new">2,499৳</span> <span class="price-old">2,950৳</span>') +
    item('Upcoming Phone', 'upcoming', '<span>Up Coming</span>')
  const [k120, x9, ...rest] = parseStartech(html)
  assert.equal(rest.length, 0)
  assert.equal(k120.name, 'Logitech K120 USB Keyboard With Bangla')
  assert.equal(k120.price, 845)
  assert.equal(k120.itemId, 'startech:logitech-k120-keyboard')
  assert.equal(k120.storeRun, true)
  assert.deepEqual([x9.price, x9.originalPrice, x9.discountPercent], [2499, 2950, 15])
  assert.deepEqual(k120.highlights, ['Connectivity: Wired'])
})

test('Pickaboo: its search page data, regular and sale price, stock, and coming soon as not in stock', () => {
  const product = (o: Record<string, unknown>) => JSON.stringify(o).replace(/"/g, '\\"')
  const html = `self.__next_f.push([1,"[\\"products\\":[${product({ id: '113236', express_delivery: '0', product_name: 'Samsung Galaxy A17 5G 6GB/128GB', sku: '', slug: 'samsung-galaxy-a17-5g-6gb-128gb', stock_available: true, product_price: 40099, product_specialPrice: 38799, rating: '5', rating_count: '4', product_img: 'https://cdn.pickaboo.com/a17.jpg', coming_soon: false })},${product({ id: '9', product_name: 'Galaxy S27', slug: 's27', stock_available: true, product_price: 150000, product_specialPrice: null, rating: null, rating_count: '0', coming_soon: true })}]"])`
  const [a17, s27] = parsePickaboo(html)
  assert.equal(a17.name, 'Samsung Galaxy A17 5G 6GB/128GB')
  assert.equal(a17.url, 'https://www.pickaboo.com/product-detail/samsung-galaxy-a17-5g-6gb-128gb')
  assert.deepEqual([a17.price, a17.originalPrice, a17.rating, a17.reviews, a17.inStock], [38799, 40099, 5, 4, true])
  assert.deepEqual([s27.price, s27.originalPrice, s27.inStock, s27.rating], [150000, null, false, null])
})

test('three shops a search: electronics may be any three, everything else is Daraz, Cartup and Othoba', () => {
  const intent = (searchQuery: string, productType: string | null = null) => ({ searchQuery, productType, brand: null })
  for (const q of ['Samsung Galaxy A17', 'gaming mouse', 'Logitech K120', 'earbuds under 2000', 'power bank']) assert.equal(segmentOf(intent(q)), 'electronics', q)
  for (const q of ['bench', 'chinigura rice', 'school bag', 'Dettol soap', 'rice cooker', 'fresh apple 1kg', 'light switch']) assert.equal(segmentOf(intent(q)), 'general', q)
  assert.deepEqual(shopsFor('general', ['startech', 'pickaboo', 'daraz']), ['daraz', 'cartup', 'othoba'])
  assert.deepEqual(shopsFor('electronics', undefined), ['daraz', 'startech', 'pickaboo'])
  assert.deepEqual(shopsFor('electronics', ['pickaboo', 'cartup', 'startech']), ['cartup', 'startech', 'pickaboo'])
  assert.deepEqual(shopsFor('electronics', ['daraz', 'cartup']), ['daraz', 'startech', 'pickaboo']) // not three: the default
  assert.deepEqual(shopsFor('electronics', ['daraz', 'evil', 'cartup', 'cartup']), ['daraz', 'startech', 'pickaboo'])
})
