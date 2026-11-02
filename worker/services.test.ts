// The data layer and the services on it, against a real SQLite database
// with the D1 migrations applied (node:sqlite standing in for D1). Network
// is faked: no store, push service or Telegram is called.
//   node --test worker/services.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { runJobs } from '../jobs/index.ts'
import { confidence, decideReview, levelOf, matchListing, matchNewListings, normalizeTitle, parseListing, type StoredListing } from './catalog.ts'
import { allow, authDevice, registerDevice } from './devices.ts'
import { recordListings } from './store.ts'
import type { D1Database, D1Statement, Listing } from './types.ts'
import { dropWorthTelling, putWatches, readWatch } from './watchlist.ts'

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  for (const file of ['0001_init.sql', '0002_architecture.sql', '0003_matching_engine.sql']) raw.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'))
  // Plain objects, as D1 returns (node:sqlite's rows have no prototype).
  const plain = (row: unknown) => (row ? { ...(row as object) } : null)
  const statement = (sql: string, params: unknown[] = []): D1Statement => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T,>() => plain(raw.prepare(sql).get(...(params as never[]))) as T | null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(params as never[])).map(plain) as T[] }),
    run: async () => raw.prepare(sql).run(...(params as never[])),
  })
  return { raw, db: { prepare: (sql: string) => statement(sql), batch: async (ss: D1Statement[]) => Promise.all(ss.map((s) => s.run())) } }
}

const listing = (itemId: string, site: Listing['site'], name: string, price: number): Listing => ({
  site, itemId, name, url: `https://othoba.com/${itemId}`, image: '', price, originalPrice: null, discountPercent: null, seller: '', brand: '',
  rating: null, reviews: 0, sold: '', inStock: true, location: '', officialStore: false, badges: [], highlights: [], relevance: 0, matchedFeatures: [],
})

test('a device proves itself with its token; only its hash is stored', async () => {
  const { db, raw } = freshDb()
  const { deviceId, token } = await registerDevice(db, 'en', '2026-11-03T00:00:00Z')
  const asked = (auth: string) => new Request('https://x/', { headers: { authorization: auth } })
  assert.equal((await authDevice(db, asked(`Bearer ${token}`)))?.id, deviceId)
  assert.equal(await authDevice(db, asked(`Bearer ${deviceId}.wrongwrongwrongwrongwrongwrong`)), null)
  const row = raw.prepare('SELECT token_hash FROM devices').get() as { token_hash: string }
  assert.ok(!token.includes(row.token_hash) && row.token_hash.length === 64)
})

test('rate limits count per window', async () => {
  const { db } = freshDb()
  const now = new Date('2026-11-03T10:15:00Z')
  assert.equal(await allow(db, 'k', 2, 3600, now), true)
  assert.equal(await allow(db, 'k', 2, 3600, now), true)
  assert.equal(await allow(db, 'k', 2, 3600, now), false)
  assert.equal(await allow(db, 'k', 2, 3600, new Date('2026-11-03T11:00:00Z')), true)
})

test('a watch needs a real store product address', () => {
  assert.equal(readWatch({ itemId: 'x', site: 'daraz', url: 'https://evil.example/products/x-i1.html', savedPrice: 10 }), null)
  assert.equal(readWatch({ itemId: '1', site: 'cartup', url: 'https://www.daraz.com.bd/products/x-i1.html', savedPrice: 10 }), null)
  assert.equal(readWatch({ itemId: '1', site: 'daraz', url: 'https://www.daraz.com.bd/products/x-i1.html?spm=1', savedPrice: 10 })?.url, 'https://www.daraz.com.bd/products/x-i1.html')
})

test('a drop is told when it reaches the target, or 5% below the saved price, and only once', () => {
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: null, alerted_price: null }, 960), false)
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: null, alerted_price: null }, 950), true)
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: 800, alerted_price: null }, 900), false)
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: 800, alerted_price: null }, 799), true)
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: null, alerted_price: 900 }, 900), false)
  assert.equal(dropWorthTelling({ saved_price: 1000, target_price: null, alerted_price: 900 }, 880), true)
})

test('the matching pipeline: brand, model, title, specs and fingerprint of a listing', () => {
  const phone = parseListing('Samsung Galaxy A36 5G (8GB/256GB) - Awesome Black', 'Samsung', null)
  assert.deepEqual([phone.brand, phone.brandFrom, phone.model, phone.specs.storage, phone.specs.network, phone.specs.colour], ['samsung', 'store', 'a36', 256, '5g', 'black'])
  // No brand from the store: the title's first word, unless it's a generic one.
  assert.equal(parseListing('Prestige Electric Kettle - 2L', 'No Brand', null).brand, 'prestige')
  assert.equal(parseListing('Wireless Earbuds TWS Bluetooth 5.3', 'No Brand', null).brand, null)
  // Amounts in one spelling, so "1 Kg" and "1kg" are one product.
  assert.equal(normalizeTitle('Starship Full Cream Milk Powder – 1 Kg'), normalizeTitle('STARSHIP Full-Cream Milk Powder 1kg'))
  assert.equal(parseListing('Starship Full Cream Milk Powder – 1 Kg', 'Starship', null).fingerprint, parseListing('Starship Full Cream Milk Powder 1kg', '', null).fingerprint)
})

test('the matching pipeline: confidence, and the conflicts that make it zero', () => {
  const p = (name: string, brand = '', image: string | null = null) => parseListing(name, brand, image)
  const starship = p('Starship Full Cream Milk Powder - 1kg', 'Starship')
  assert.equal(levelOf(confidence(p('Starship Full Cream Milk Powder – 1 Kg', 'Starship'), starship).score), 'high')
  assert.match(confidence(p('Farmland Full Cream Milk Powder – 1kg', 'Farmland'), starship).reasons[0], /different brand/)
  assert.match(confidence(p('Starship Full Cream Milk Powder - 500gm', 'Starship'), starship).reasons[0], /different size/)
  assert.match(confidence(p('Samsung Galaxy A36 5G 8/128GB', 'Samsung'), p('Samsung Galaxy A36 5G 8/256GB', 'Samsung')).reasons[0], /different storage/)
  // Alike, not identical: a person decides.
  assert.ok(['medium', 'low'].includes(levelOf(confidence(p('Starship Instant Full Cream Milk Powder 1kg'), starship).score)))
  // Two No Brand watches that differ in one word: unsure on words, sure with the same photo file.
  const men = p('Fashion Sports Led Watch, Upgraded Version Electronic Bracelet Gift watch for Men', 'No Brand', 'https://x/p/2c6060c50c1952d4884713f4be91002b.jpg')
  const students = p('Fashion Sports Led Watch, Upgraded Version Electronic Bracelet Gift watch for Students', 'No Brand')
  assert.notEqual(levelOf(confidence(students, men).score), 'high')
  assert.equal(levelOf(confidence(students, men, true).score), 'high')
})

test('the matching pipeline over the database: link, new product, review, and the decisions', async () => {
  const { db, raw } = freshDb()
  const at = (h: number) => `2026-11-03T0${h}:00:00Z`
  const offer = (itemId: string, site: Listing['site'], name: string, brand: string) => ({ ...listing(itemId, site, name, 700), brand })
  const steps: [Listing, string][] = [
    [offer('d1', 'daraz', 'Starship Full Cream Milk Powder - 1kg', 'Starship'), 'new'],
    [offer('cartup:2', 'cartup', 'Starship Full Cream Milk Powder – 1 Kg', 'Starship'), 'auto'],
    [offer('cartup:3', 'cartup', 'Farmland Full Cream Milk Powder – 1kg', 'Farmland'), 'new'],
    [offer('d4', 'daraz', 'Starship Full Cream Milk Powder - 500gm', 'Starship'), 'new'],
    [offer('othoba:5', 'othoba', 'Starship Instant Full Cream Milk Powder 1kg', ''), 'review'],
  ]
  for (const [i, [l, expected]] of steps.entries()) {
    await recordListings(db, [l], at(i))
    const stored = raw.prepare('SELECT item_id, site, name, brand, image FROM listings WHERE item_id = ?').get(l.itemId) as unknown as StoredListing
    assert.equal((await matchListing(db, { ...stored }, at(i))).outcome, expected, l.name)
  }
  const productOf = (id: string) => (raw.prepare('SELECT product_id FROM listings WHERE item_id = ?').get(id) as { product_id: number | null }).product_id
  assert.equal(productOf('cartup:2'), productOf('d1'))
  assert.equal(productOf('othoba:5'), null)

  // "Same product": linked by hand.
  const review = raw.prepare("SELECT id, product_id FROM match_reviews WHERE item_id = 'othoba:5'").get() as { id: number; product_id: number }
  assert.equal(review.product_id, productOf('d1'))
  assert.equal(await decideReview(db, review.id, true, at(6)), true)
  assert.equal(productOf('othoba:5'), productOf('d1'))
  assert.equal(await decideReview(db, review.id, true, at(6)), false)

  // "Different": back through the pipeline without that product, so a new one.
  await recordListings(db, [offer('othoba:6', 'othoba', 'Starship Instant Full Cream Milk Powder 1kg', '')], at(7))
  assert.deepEqual(await matchNewListings(db, at(7), 10), { new: 0, auto: 0, review: 1 })
  const second = raw.prepare("SELECT id FROM match_reviews WHERE item_id = 'othoba:6'").get() as { id: number }
  await decideReview(db, second.id, false, at(8))
  assert.deepEqual(await matchNewListings(db, at(8), 10), { new: 1, auto: 0, review: 0 })
  assert.notEqual(productOf('othoba:6'), productOf('d1'))

  // A renamed listing is matched again.
  await recordListings(db, [offer('cartup:3', 'cartup', 'Farmland Full Cream Milk Powder 1kg Tin', 'Farmland')], at(9))
  assert.equal((raw.prepare("SELECT match_status FROM listings WHERE item_id = 'cartup:3'").get() as { match_status: string | null }).match_status, null)
})

test('scheduled jobs: a watched product is checked, its drop recorded and pushed once', async () => {
  const { db, raw } = freshDb()
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey)
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64url')
  const env = { PP_DB: db, VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_JWK: JSON.stringify(jwk) }

  const { deviceId } = await registerDevice(db, 'en', '2026-11-03T00:00:00Z')
  raw.prepare('UPDATE devices SET push_endpoint = ? WHERE id = ?').run('https://fcm.googleapis.com/fcm/send/abc', deviceId)
  const watch = readWatch({ itemId: 'othoba:9', site: 'othoba', name: 'Fresh Soybean Oil 5ltr', url: 'https://othoba.com/fresh-soybean-oil-5ltr', savedPrice: 1000 })!
  assert.equal(await putWatches(db, deviceId, [watch], '2026-11-03T00:00:00Z'), true)

  const pushes: { url: string; authorization: string }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://othoba.com/')) {
      const ld = { '@type': 'Product', name: 'Fresh Soybean Oil 5ltr', id: '9', offers: { price: '900', availability: 'http://schema.org/InStock' } }
      return new Response(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      pushes.push({ url, authorization: String(new Headers(init?.headers).get('authorization')) })
      return new Response(null, { status: 201 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const first = await runJobs(env, new Date('2026-11-03T00:10:00Z'))
    assert.deepEqual(first, { checked: 1, alerts: 1, failed: 0, matched: 1 })
    assert.equal(pushes.length, 1)
    // VAPID: a signed JWT for the push service's origin, and our public key.
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(pushes[0].authorization) ?? []
    assert.equal(k, pub)
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    assert.equal(claims.aud, 'https://fcm.googleapis.com')
    const [header, body, sig] = jwt.split('.')
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${header}.${body}`)))

    assert.deepEqual({ ...(raw.prepare('SELECT old_price, new_price, push_status FROM alerts').get() as object) }, { old_price: 1000, new_price: 900, push_status: 'sent' })
    assert.deepEqual({ ...(raw.prepare('SELECT last_price, alerted_price FROM watches').get() as object) }, { last_price: 900, alerted_price: 900 })
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM price_history WHERE item_id = 'othoba:9'").get() as { n: number }).n, 1)

    // Ten minutes later: checked recently, so nothing is due, and nothing is told twice.
    assert.deepEqual(await runJobs(env, new Date('2026-11-03T00:20:00Z')), { checked: 0, alerts: 0, failed: 0, matched: 0 })
    // Seven hours later it's checked again; the same price is not news.
    assert.deepEqual(await runJobs(env, new Date('2026-11-03T07:20:00Z')), { checked: 1, alerts: 0, failed: 0, matched: 0 })
  } finally {
    globalThis.fetch = real
  }
})
