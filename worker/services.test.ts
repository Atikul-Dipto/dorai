// The data layer and the services on it, against a real SQLite database
// with the D1 migrations applied (node:sqlite standing in for D1). Network
// is faked: no store, push service or Telegram is called.
//   node --test worker/services.test.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { onRequestDelete as authDelete, onRequestGet as authGet, onRequestPost as authPost } from '../functions/api/pp/auth.ts'
import { onRequestGet as askGet, onRequestPost as askPost } from '../functions/api/pp/ask.ts'
import { onRequestGet as compareGet, onRequestPost as comparePost } from '../functions/api/pp/compare.ts'
import { onRequestPost as partPost } from '../functions/api/pp/part.ts'
import { runJobs } from '../jobs/index.ts'
import { admit, forGuest, GUEST_ROWS, GUEST_SEARCHES, giveBack, guestCount, historyKey } from './access.ts'
import { deleteAccount, logIn, profileKey, sessionUser, setHistory } from './accounts.ts'
import { run } from './agent.ts'
import { parseProductPage as parseDarazPage } from './daraz.ts'
import { confidence, decideReview, findProducts, levelOf, matchListing, matchNewListings, normalizeTitle, parseListing, type StoredListing } from './catalog.ts'
import { allow, authDevice, registerDevice } from './devices.ts'
import { readInteraction, recordInteractions, summarizeInteractions } from './interactions.ts'
import { forgetProfile, listProfiles, patternOf, readProfile, visitorKey } from './profiles.ts'
import { callPart, onThisSite, partKey } from './parts.ts'
import { logAsk, recordListings } from './store.ts'
import type { D1Database, D1Statement, Listing } from './types.ts'
import { dropWorthTelling, putWatches, readWatch } from './watchlist.ts'

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:')
  for (const file of ['0001_init.sql', '0002_architecture.sql', '0003_matching_engine.sql', '0004_interactions.sql', '0005_visitor_profiles.sql', '0006_accounts.sql']) raw.exec(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'))
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

const askedBy = (db: D1Database, visitor: string | null, askedAt: string, query = 'Awei T50', mode = 'product') =>
  logAsk(db, { visitor, askedAt, query, mode, intentSource: 'rules', results: 3, bestPrice: 1100, bestFinal: 1100, voucherApplied: false, totalMs: 5, timings: {}, error: null })
const act = (kind: string, price = 1100) => readInteraction({ kind, query: 'Awei T50', itemId: '111', site: 'daraz', slot: 'pick', price })!

test('visitor profiles: only a real id counts, and only its salted hash is stored', async () => {
  const env = { RATE_SALT: 'salt' }
  const id = 'a'.repeat(32)
  const key = (await visitorKey(env, id))!
  assert.equal(await visitorKey(env, undefined), null)
  assert.equal(await visitorKey(env, 'not-an-id'), null)
  assert.equal(await visitorKey(env, id.toUpperCase()), null)
  assert.equal(await visitorKey(env, id), key)
  assert.notEqual(await visitorKey({ RATE_SALT: 'other' }, id), key)
  assert.ok(!key.includes(id.slice(0, 8)))
})

test("visitor profiles: a profile holds that visitor's rows and no one else's", async () => {
  const { db } = freshDb()
  const at = '2026-11-03T14:00:00Z'
  await recordListings(db, [{ ...listing('111', 'daraz', 'Awei T50 Wireless Earbuds', 1100), brand: 'Awei' }], at)
  await askedBy(db, 'me', at)
  await askedBy(db, 'me', '2026-11-03T14:05:00Z', 'awei t50 ')
  await askedBy(db, 'me', '2026-11-03T14:10:00Z', 'quiet fan', 'need')
  await askedBy(db, 'someone', at, 'rice cooker')
  await askedBy(db, null, at, 'nobody in particular')
  await recordInteractions(db, [act('open'), act('save')], at, 'me')
  await recordInteractions(db, [act('open', 9000)], at, 'someone')
  await recordInteractions(db, [act('not_this')], at)

  const list = (await listProfiles(db)) as { key: string; searches: number; opens: number; saves: number }[]
  assert.deepEqual(list.map((v) => v.key).sort(), ['me', 'someone'])
  const mine = list.find((v) => v.key === 'me')!
  assert.deepEqual([mine.searches, mine.opens, mine.saves], [3, 1, 1])

  const profile = (await readProfile(db, 'me'))!
  const p = profile.pattern
  assert.equal(p.searches, 3)
  assert.equal(p.differentSearches, 2)
  assert.deepEqual(p.searchedAgain, [{ value: 'awei t50', n: 2 }])
  assert.deepEqual(p.howTheySearch, [{ value: 'product', n: 2 }, { value: 'need', n: 1 }])
  assert.equal(p.openedFrom, 1)
  assert.deepEqual(p.brands, [{ value: 'Awei', n: 2 }])
  assert.deepEqual(p.priceRange, { low: 1100, middle: 1100, high: 1100 })
  assert.deepEqual(p.partsOfDay, [{ value: 'evening', n: 3 }]) // 14:00 UTC is 20:00 in Bangladesh
  assert.deepEqual(p.products.map((o) => [o.name, o.opens, o.saves]), [['Awei T50 Wireless Earbuds', 1, 1]])
  assert.equal(profile.timeline.length, 5)
  assert.ok(!profile.timeline.some((a) => a.query === 'rice cooker' || a.query === 'nobody in particular'))
  assert.equal(await readProfile(db, 'no one'), null)
})

test('visitor profiles: the pattern leaves out what says nothing', () => {
  const p = patternOf([], [{ at: '2026-11-03T02:00:00Z', kind: 'open', query: 'fan', itemId: '1', site: 'othoba', price: null, name: null, url: null, brand: 'No Brand' }])
  assert.deepEqual(p.brands, [])
  assert.equal(p.priceRange, null)
  assert.equal(p.openedFrom, 0)
  assert.deepEqual(p.stores, [{ value: 'othoba', n: 1 }])
})

test('visitor profiles: turning it off deletes that history and nothing else', async () => {
  const { db, raw } = freshDb()
  const at = '2026-11-03T14:00:00Z'
  await askedBy(db, 'me', at)
  await askedBy(db, 'someone', at)
  await askedBy(db, null, at)
  await recordInteractions(db, [act('open')], at, 'me')
  await recordInteractions(db, [act('open')], at)
  await forgetProfile(db, 'me')
  assert.equal(await readProfile(db, 'me'), null)
  assert.ok(await readProfile(db, 'someone'))
  assert.deepEqual({ ...(raw.prepare('SELECT COUNT(*) AS n FROM asks').get() as object) }, { n: 2 })
  assert.deepEqual({ ...(raw.prepare('SELECT COUNT(*) AS n FROM interactions').get() as object) }, { n: 1 })
})

test('visitor profiles: after a year the rows stay and the link goes, in the daily run only', async () => {
  const { db, raw } = freshDb()
  await askedBy(db, 'me', '2025-01-01T00:00:00Z', 'old')
  await askedBy(db, 'me', '2026-11-01T00:00:00Z', 'recent')
  await recordInteractions(db, [act('open')], '2025-01-01T00:00:00Z', 'me')
  const linked = () => (raw.prepare('SELECT COUNT(*) AS n FROM (SELECT visitor FROM asks UNION ALL SELECT visitor FROM interactions) WHERE visitor IS NOT NULL').get() as { n: number }).n
  await runJobs({ PP_DB: db }, new Date('2026-11-03T12:00:00Z'))
  assert.equal(linked(), 3)
  await runJobs({ PP_DB: db }, new Date('2026-11-03T00:05:00Z'))
  assert.equal(linked(), 1)
  assert.deepEqual({ ...(raw.prepare('SELECT COUNT(*) AS n FROM asks').get() as object) }, { n: 2 })
  assert.equal((await readProfile(db, 'me'))?.pattern.searches, 1)
})

// The API as a browser uses it: a cookie jar, one address.
function browser(env: { PP_DB: D1Database }, address = '203.0.113.1') {
  const jar = new Map<string, string>()
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [name, value] = line.split(';')[0].split('=')
      if (value) jar.set(name, value)
      else jar.delete(name)
    }
    return response
  }
  const request = (url: string, method: string, body?: unknown) =>
    new Request(`https://dorai.test/api/pp/${url}`, {
      method,
      headers: { 'cf-connecting-ip': address, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const auth = async (body: unknown) => {
    const response = keep(await authPost({ request: request('auth', 'POST', body), env }))
    return { status: response.status, body: (await response.json()) as Record<string, any>, response }
  }
  return { jar, keep, request, auth, ctx: (url: string, method: string, body?: unknown) => ({ request: request(url, method, body), env, waitUntil: () => {} }) }
}
const SIGNUP = { action: 'signup', email: 'Rahim@Example.com ', password: 'correct horse' }

test('accounts: sign up, log in, log out; the password is never stored, and the cookie is out of scripts\' reach', async () => {
  const { db, raw } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const made = await page.auth(SIGNUP)
  assert.equal(made.status, 201)
  assert.equal(made.body.user.email, 'rahim@example.com')
  assert.match(made.body.recoveryCode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
  const cookie = made.response.headers.getSetCookie()[0]
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookie.includes(part))

  const row = raw.prepare('SELECT * FROM users').get() as Record<string, unknown>
  assert.ok(!JSON.stringify(row).includes('correct horse'))
  assert.ok(!JSON.stringify(row).includes(made.body.recoveryCode))
  assert.equal(row.rounds, 100000)
  const session = raw.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string }
  assert.notEqual(session.token_hash, page.jar.get('dorai_session'))

  const who = async () => (await (await authGet({ request: page.request('auth', 'GET'), env })).json()) as Record<string, any>
  assert.equal((await who()).user.email, 'rahim@example.com')
  await page.auth({ action: 'logout' })
  assert.equal((await who()).user, null)
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0)

  assert.equal((await page.auth({ action: 'login', email: 'rahim@example.com', password: 'wrong password' })).status, 401)
  assert.equal((await page.auth({ action: 'login', email: 'nobody@example.com', password: 'correct horse' })).body.code, 'wrong')
  assert.equal((await page.auth({ action: 'login', email: 'RAHIM@example.com', password: 'correct horse' })).status, 200)
  assert.equal((await who()).user.email, 'rahim@example.com')
})

test('accounts: bad details are refused, and an address has one account', async () => {
  const { db } = freshDb()
  const page = browser({ PP_DB: db })
  assert.equal((await page.auth({ ...SIGNUP, email: 'not an email' })).body.code, 'badEmail')
  assert.equal((await page.auth({ ...SIGNUP, password: 'short' })).body.code, 'shortPassword')
  assert.equal((await page.auth({ action: 'nonsense' })).body.code, 'badAction')
  assert.equal((await page.auth(SIGNUP)).status, 201)
  assert.equal((await page.auth(SIGNUP)).body.code, 'taken')
})

test('accounts: a recovery code resets the password once, and ends every old session', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const { body } = await page.auth(SIGNUP)
  const elsewhere = new Map(page.jar)
  const reset = (code: string, password = 'a new password') => page.auth({ action: 'reset', email: SIGNUP.email, code, password })
  assert.equal((await reset('AAAA-BBBB-CCCC-DDDD')).body.code, 'badCode')
  assert.equal((await reset(body.recoveryCode, 'short')).body.code, 'shortPassword')
  const done = await reset(body.recoveryCode.toLowerCase().replaceAll('-', ' '))
  assert.equal(done.status, 200)
  assert.notEqual(done.body.recoveryCode, body.recoveryCode)
  assert.equal((await reset(body.recoveryCode, 'another password')).body.code, 'badCode')
  assert.equal(await logIn(db, 'rahim@example.com', SIGNUP.password), null)
  assert.ok(await logIn(db, 'rahim@example.com', 'a new password'))
  const old = new Request('https://dorai.test/', { headers: { cookie: `dorai_session=${elsewhere.get('dorai_session')}` } })
  assert.equal(await sessionUser(db, old, new Date()), null)
})

test('accounts: too many wrong passwords on one account are stopped, from any address', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  await browser(env).auth(SIGNUP)
  const statuses: number[] = []
  for (let i = 0; i < 12; i++) statuses.push((await browser(env, `203.0.113.${i + 10}`).auth({ action: 'login', email: SIGNUP.email, password: 'guessing wrong' })).status)
  assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429])
})

test('accounts: a session ends when it expires', async () => {
  const { db } = freshDb()
  const page = browser({ PP_DB: db })
  await page.auth(SIGNUP)
  const request = page.request('auth', 'GET')
  assert.ok(await sessionUser(db, request, new Date()))
  assert.equal(await sessionUser(db, request, new Date(Date.now() + 91 * 86_400_000)), null)
})

test('guests: five searches, counted on the server, then a wall; an account passes uncounted', async () => {
  const { db, raw } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const now = new Date('2026-11-07T10:00:00Z')
  const used: (number | undefined)[] = []
  for (let i = 0; i < GUEST_SEARCHES; i++) {
    const access = await admit(page.request('ask', 'POST', {}), env, now)
    assert.equal(access.allowed, true)
    used.push(access.guest?.used)
    if (access.cookie) page.jar.set('dorai_guest', access.cookie.split(';')[0].split('=')[1])
  }
  assert.deepEqual(used, [1, 2, 3, 4, 5])
  assert.equal((await guestCount(page.request('auth', 'GET'), env)).used, 5)
  const over = await admit(page.request('ask', 'POST', {}), env, now)
  assert.equal(over.allowed, false)
  assert.deepEqual(over.guest, { used: 5, limit: 5 })

  // The guest row is a count: no search, no address.
  assert.deepEqual(Object.keys(raw.prepare('SELECT * FROM guests').get() as object).sort(), ['first_at', 'key', 'last_at', 'used'])

  await page.auth(SIGNUP)
  for (let i = 0; i < 8; i++) {
    const access = await admit(page.request('ask', 'POST', {}), env, now)
    assert.equal(access.allowed, true)
    assert.equal(access.guest, null)
    assert.equal(access.user?.email, 'rahim@example.com')
  }
})

test('guests: a failed search gives its free one back', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const first = await admit(page.request('ask', 'POST', {}), env, new Date())
  page.jar.set('dorai_guest', first.cookie!.split(';')[0].split('=')[1])
  assert.equal((await giveBack(db, first)).guest?.used, 0)
  assert.equal((await guestCount(page.request('auth', 'GET'), env)).used, 0)
})

test('guests: clearing cookies starts a new trial, but one address is capped for the day', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const now = new Date('2026-11-07T10:00:00Z')
  let allowed = 0
  for (let i = 0; i < 70; i++) if ((await admit(browser(env).request('ask', 'POST', {}), env, now)).allowed) allowed++
  assert.equal(allowed, 60)
  assert.equal((await admit(browser(env, '203.0.113.99').request('ask', 'POST', {}), env, now)).allowed, true)
  assert.equal((await admit(browser(env).request('ask', 'POST', {}), env, new Date('2026-11-08T10:00:00Z'))).allowed, true)
})

test('the ask endpoint walls off a guest on every route, before any store is called', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const real = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('no store may be called')
  }) as typeof fetch
  try {
    const first = await admit(page.request('ask', 'POST', {}), env, new Date())
    page.jar.set('dorai_guest', first.cookie!.split(';')[0].split('=')[1])
    for (let i = 1; i < GUEST_SEARCHES; i++) await admit(page.request('ask', 'POST', {}), env, new Date())
    const post = await askPost(page.ctx('ask', 'POST', { name: 'Awei T50' }))
    assert.equal(post.status, 401)
    assert.deepEqual(await post.json(), { error: 'Log in to keep searching.', needLogin: true, guest: { used: 5, limit: 5 } })
    assert.equal((await askGet(page.ctx('ask?q=Awei%20T50', 'GET'))).status, 401)
  } finally {
    globalThis.fetch = real
  }
})

test("compare: the site's links count for a guest; the extension's GET stays open", async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const link = 'https://www.daraz.com.bd/products/awei-t50-i562252743.html'
  const first = await admit(page.request('ask', 'POST', {}), env, new Date())
  page.jar.set('dorai_guest', first.cookie!.split(';')[0].split('=')[1])
  for (let i = 1; i < GUEST_SEARCHES; i++) await admit(page.request('ask', 'POST', {}), env, new Date())
  const real = globalThis.fetch
  globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
  try {
    assert.equal((await comparePost(page.ctx('compare', 'POST', { link }))).status, 401)
    assert.notEqual((await compareGet(page.ctx(`compare?link=${encodeURIComponent(link)}`, 'GET'))).status, 401)
  } finally {
    globalThis.fetch = real
  }
})

test('a guest sees each store\'s pick and first rows; the answer says how many more an account shows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ listing: { name: `Offer ${i}` } }))
  const answer = { hotDeal: 'kept', stores: [{ site: 'daraz', recommended: 'pick', matches: rows(GUEST_ROWS + 5) }, { site: 'othoba', recommended: 'pick', matches: rows(GUEST_ROWS) }] }
  const seen = forGuest(answer, 'something else') as unknown as { hotDeal: string; stores: { recommended: string; matches: unknown[]; hiddenMatches?: number }[] }
  assert.equal(seen.hotDeal, 'kept')
  assert.equal(seen.stores[0].recommended, 'pick')
  assert.equal(seen.stores[0].matches.length, GUEST_ROWS)
  assert.equal(seen.stores[0].hiddenMatches, 5)
  assert.equal(seen.stores[1].hiddenMatches, undefined)
  assert.equal(answer.stores[0].matches.length, GUEST_ROWS + 5) // what's cached stays whole

  // The exact name they searched for is never held back, however far down it ranks.
  const named = forGuest(answer, 'offer  6') as unknown as { stores: { matches: { listing: { name: string } }[]; hiddenMatches?: number }[] }
  assert.deepEqual(named.stores[0].matches.map((m) => m.listing.name), ['Offer 0', 'Offer 1', 'Offer 6'])
  assert.equal(named.stores[0].hiddenMatches, 4)
})

const CARTUP_DOWN = '<html><body><p>The product is temporarily unavailable. </p></body></html>'
const LINK = 'https://www.cartup.com/product/herman_chilli_mayanise_500ml_637903106336006_nw7yc5'

test("a listing that's gone: the site searches its name instead, and says so", async () => {
  const { db } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/pp/part')) return partPost({ request: new Request(url, init), env })
    if (url.includes('/product/')) return new Response(CARTUP_DOWN)
    if (url.includes('daraz.com.bd')) return Response.json({ mods: { listItems: [{ itemId: '555', name: 'Herman Chilli Mayanise 500ml', price: '300', itemUrl: '//www.daraz.com.bd/products/herman-i555.html', sellerName: 'Shop', ratingScore: '4.5', review: '20' }] } })
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const shown = await comparePost(page.ctx('compare', 'POST', { link: LINK }))
    assert.equal(shown.status, 200)
    const body = (await shown.json()) as { fromLink: { label: string }; stores: { site: string; recommended: { listing: { itemId: string } } | null }[] }
    assert.deepEqual(body.fromLink, { site: 'cartup', label: 'Cartup' })
    assert.equal(body.stores.find((s) => s.site === 'daraz')?.recommended?.listing.itemId, '555')

    // The extension can't show that, so it gets the reason, in plain words.
    const refused = await compareGet(page.ctx(`compare?link=${encodeURIComponent(LINK)}`, 'GET'))
    assert.equal(refused.status, 502)
    assert.deepEqual(await refused.json(), { error: "Cartup isn't showing this listing right now." })
  } finally {
    globalThis.fetch = real
  }
})

test("a gone listing with no name worth searching gives a free search back", async () => {
  const { db, raw } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/pp/part')) return partPost({ request: new Request(url, init), env })
    return url.includes('catalog') ? Response.json({ mods: { listItems: [] } }) : new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const answer = page.keep(await comparePost(page.ctx('compare', 'POST', { link: 'https://www.daraz.com.bd/products/3-1-i344199128.html' })))
    assert.equal(answer.status, 502)
    assert.deepEqual(await answer.json(), { error: "Daraz isn't showing this listing right now.", guest: { used: 0, limit: 5 } })
    assert.deepEqual({ ...(raw.prepare('SELECT used FROM guests').get() as object) }, { used: 0 })
  } finally {
    globalThis.fetch = real
  }
})

test("a Daraz product its search doesn't list is read from its own page", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":" R1s Selfie Stick ","image":["https://static.test/a.jpg"],"brand":{"name":"No Brand"},"offers":{"@type":"AggregateOffer","availability":"https://schema.org/InStock"}}</script>
    <script>var pdpTrackingData = "{\\"pdt_sku\\":\\"320314671\\",\\"pdt_price\\":\\"৳ 1,350\\"}";</script>`
  const listing = parseDarazPage(html, '320314671', 'https://www.daraz.com.bd/products/r1s-i320314671.html')!
  assert.equal(listing.name, 'R1s Selfie Stick')
  assert.equal(listing.price, 1350)
  assert.equal(listing.inStock, true)
  assert.equal(listing.image, 'https://static.test/a.jpg')
  assert.equal(parseDarazPage('<html>a page with no product</html>', '1', 'x'), null)
  assert.equal(parseDarazPage(html.replace('InStock', 'OutOfStock'), '1', 'x')?.inStock, false)
})

test("accounts: search history needs a yes, follows the account, and a guest's joins it", async () => {
  const { db } = freshDb()
  const env = { PP_DB: db, RATE_SALT: 'salt' }
  const at = '2026-11-07T10:00:00Z'
  const page = browser(env)
  const id = 'c'.repeat(32)
  const guestKey = (await historyKey(env, { user: null }, id))!
  await askedBy(db, guestKey, at, 'as a guest')

  const said = await page.auth({ ...SIGNUP, history: false, visitor: id })
  const user = { id: 1, email: said.body.user.email, history: false }
  assert.equal(await historyKey(env, { user }, id), null) // no: nothing links, and the guest's rows stay where they are
  assert.equal((await readProfile(db, profileKey(user))), null)

  await page.auth({ action: 'history', on: true })
  await page.auth({ action: 'login', email: SIGNUP.email, password: SIGNUP.password, visitor: id })
  assert.equal(await historyKey(env, { user: { ...user, history: true } }, id), 'u1')
  assert.equal((await readProfile(db, 'u1'))?.pattern.searches, 1)
  assert.equal(await readProfile(db, guestKey), null)

  await recordInteractions(db, [act('open')], at, 'u1')
  const list = (await listProfiles(db)) as { key: string; email: string | null }[]
  assert.deepEqual(list.map((v) => [v.key, v.email]), [['u1', 'rahim@example.com']])
  assert.equal((await readProfile(db, 'u1'))?.email, 'rahim@example.com')

  await setHistory(db, { ...user, history: true }, false)
  assert.equal(await readProfile(db, 'u1'), null)
})

test('accounts: deleting one takes its sessions and history, and needs the password', async () => {
  const { db, raw } = freshDb()
  const env = { PP_DB: db }
  const page = browser(env)
  await page.auth({ ...SIGNUP, history: true })
  await askedBy(db, 'u1', '2026-11-07T10:00:00Z')
  await askedBy(db, null, '2026-11-07T10:00:00Z')
  const remove = async (password: string) => page.keep(await authDelete({ request: page.request('auth', 'DELETE', { password }), env }))
  assert.equal((await remove('not the password')).status, 401)
  assert.ok(await readProfile(db, 'u1'))
  assert.equal((await remove(SIGNUP.password)).status, 200)
  for (const table of ['users', 'sessions']) assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0)
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM asks').get() as { n: number }).n, 1)
  assert.equal(page.jar.has('dorai_session'), false)
  assert.equal(await logIn(db, 'rahim@example.com', SIGNUP.password), null)
  await deleteAccount(db, { id: 99, email: 'gone@example.com', history: false }) // nothing there: no error
})

test('store reads run as requests of their own, for this site only', async () => {
  const env = { RATE_SALT: 'salt' }
  const seen: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/api/pp/part')) return partPost({ request: new Request(url, init), env })
    return new Response(JSON.stringify({ mods: { listItems: [] } }), { status: 200 })
  }) as typeof fetch
  try {
    const here = onThisSite(env, new Request('https://dorai.test/api/pp/ask'))
    assert.equal(here.SELF, 'https://dorai.test')
    assert.deepEqual((await callPart(here, 'darazSearch', 'fan')).listings, [])
    assert.equal(seen[0], 'https://dorai.test/api/pp/part?darazSearch')
    assert.ok(seen[1].includes('daraz.com.bd'))

    // Without env.SELF it runs in place.
    seen.length = 0
    await callPart(env, 'darazSearch', 'fan')
    assert.ok(seen.every((u) => !u.includes('/api/pp/part')))
  } finally {
    globalThis.fetch = real
  }

  const ask = (headers: Record<string, string>, body: unknown) => partPost({ request: new Request('https://dorai.test/api/pp/part', { method: 'POST', headers, body: JSON.stringify(body) }), env })
  const key = await partKey(env)
  assert.equal((await ask({}, { name: 'darazSearch', args: ['fan'] })).status, 403)
  assert.equal((await ask({ 'x-dorai-part': 'guess' }, { name: 'darazSearch', args: ['fan'] })).status, 403)
  assert.equal((await ask({ 'x-dorai-part': key }, { name: 'constructor', args: [] })).status, 400)
  assert.equal((await ask({ 'x-dorai-part': key }, { name: 'darazSearch' })).status, 400)
  assert.notEqual(await partKey({ RATE_SALT: 'another' }), key)
})

test('a store whose read fails costs its own results, not the answer', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db, SELF: 'https://dorai.test' }
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { name } = JSON.parse(String(init?.body)) as { name: string }
    // The way Cloudflare answers when a request runs out of CPU.
    if (name !== 'darazSearch') return new Response('error code: 1102', { status: 503 })
    const item = { itemId: '111', name: 'Awei T50 Wireless Earbuds', price: '1150', itemUrl: '//www.daraz.com.bd/products/x-i111.html', image: '', sellerName: 'Shop', brandName: 'Awei', ratingScore: '4.5', review: '10', inStock: true }
    return Response.json({ result: { listings: [listing('111', 'daraz', item.name, 1150)], categories: [], url: 'https://www.daraz.com.bd/catalog/?q=awei' } })
  }) as typeof fetch
  try {
    const answer = await run({ name: 'Awei T50', details: '', shops: ['daraz', 'cartup', 'othoba'] }, env)
    assert.equal(answer.stores.length, 3)
    assert.equal(answer.stores.find((s) => s.site === 'daraz')?.recommended?.listing.itemId, '111')
    assert.equal(answer.stores.find((s) => s.site === 'cartup')?.recommended, null)
  } finally {
    globalThis.fetch = real
  }
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

test('learning events: only real acts on real offers are kept, each with its canonical product, and summed up for the owner', async () => {
  const { db, raw } = freshDb()
  const at = '2026-11-03T05:00:00Z'
  await recordListings(db, [{ ...listing('111', 'daraz', 'Awei T50 Wireless Earbuds', 1100), brand: 'Awei' }], at)
  await matchNewListings(db, at, 10)
  const event = { kind: 'open', query: 'Awei T50', itemId: '111', site: 'daraz', slot: 'pick', price: 1100 }
  assert.equal(readInteraction({ ...event, kind: 'buy' }), null)
  assert.equal(readInteraction({ ...event, site: 'amazon' }), null)
  assert.equal(readInteraction({ ...event, itemId: "1'; DROP TABLE x" }), null)
  // A pick is position 0 with no relation, whatever the page sent.
  assert.deepEqual(readInteraction({ ...event, relation: 'close', position: 4 }), { ...event, relation: null, position: 0 })
  const row = readInteraction({ ...event, slot: 'match', relation: 'variant', position: 2 })!
  await recordInteractions(db, [readInteraction(event)!, row, readInteraction({ ...event, kind: 'not_this' })!], at)
  const stored = raw.prepare('SELECT kind, product_id FROM interactions ORDER BY id').all() as { kind: string; product_id: number | null }[]
  assert.deepEqual(stored.map((s) => s.kind), ['open', 'open', 'not_this'])
  assert.ok(stored.every((s) => s.product_id !== null))
  const summary = await summarizeInteractions(db, '2026-11-01T00:00:00Z')
  assert.deepEqual(summary.counts, { not_this: 1, open: 2 })
  assert.equal((summary.notWanted[0] as { query: string }).query, 'Awei T50')
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
  assert.match(confidence(p('Samyang 2x Spicy Ramen 140gm (Single Pack) Korea'), p('Samyang 3x Spicy Ramen - 140g Single Pack Korea')).reasons[0], /different strength/)
  assert.match(confidence(p("Hell's Paradise: Jigokuraku, Vol. 4"), p("Hell's Paradise: Jigokuraku, Vol. 2")).reasons[0], /different volume/)
  assert.match(confidence(p('Rubik Magic Cube 3x3'), p('Rubik Magic Cube 4x4')).reasons[0], /different dimensions/)
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
    [offer('cartup:6', 'cartup', 'Starship Instant Full Cream Milk Powder 1kg', ''), 'review'],
  ]
  for (const [i, [l, expected]] of steps.entries()) {
    await recordListings(db, [l], at(i))
    const stored = raw.prepare('SELECT item_id, site, name, brand, image FROM listings WHERE item_id = ?').get(l.itemId) as unknown as StoredListing
    assert.equal((await matchListing(db, { ...stored }, at(i))).outcome, expected, l.name)
  }
  const productOf = (id: string) => (raw.prepare('SELECT product_id FROM listings WHERE item_id = ?').get(id) as { product_id: number | null }).product_id
  const reviewOf = (id: string) => raw.prepare('SELECT id, product_id FROM match_reviews WHERE item_id = ? ORDER BY id DESC').get(id) as { id: number; product_id: number }
  assert.equal(productOf('cartup:2'), productOf('d1'))
  assert.equal(productOf('othoba:5'), null)

  // "Same product": linked by hand, with the same title from another store in the same decision.
  assert.equal(reviewOf('othoba:5').product_id, productOf('d1'))
  assert.equal(await decideReview(db, reviewOf('othoba:5').id, true, at(7)), 2)
  assert.equal(productOf('othoba:5'), productOf('d1'))
  assert.equal(productOf('cartup:6'), productOf('d1'))
  assert.equal(await decideReview(db, reviewOf('othoba:5').id, true, at(7)), 0)
  // ...and that title arriving later follows the decision.
  await recordListings(db, [offer('othoba:7', 'othoba', 'Starship Instant Full Cream Milk Powder 1kg', '')], at(8))
  assert.deepEqual(await matchNewListings(db, at(8), 10), { new: 0, auto: 0, review: 0, manual: 1 })
  assert.equal(productOf('othoba:7'), productOf('d1'))

  // "Different": back through the pipeline without that product, so a new one, which the twin then joins.
  await recordListings(db, [offer('d8', 'daraz', 'Starship Full Cream Milk Powder Pouch 1kg', ''), offer('d9', 'daraz', 'Starship Full Cream Milk Powder Pouch 1kg', '')], at(9))
  assert.deepEqual(await matchNewListings(db, at(9), 10), { new: 0, auto: 0, review: 2, manual: 0 })
  assert.equal(await decideReview(db, reviewOf('d8').id, false, at(9)), 2)
  assert.deepEqual(await matchNewListings(db, at(9), 10), { new: 1, auto: 1, review: 0, manual: 0 })
  assert.equal(productOf('d8'), productOf('d9'))
  assert.notEqual(productOf('d8'), productOf('d1'))

  // A renamed listing is matched again.
  await recordListings(db, [offer('cartup:3', 'cartup', 'Farmland Full Cream Milk Powder 1kg Tin', 'Farmland')], at(9))
  assert.equal((raw.prepare("SELECT match_status FROM listings WHERE item_id = 'cartup:3'").get() as { match_status: string | null }).match_status, null)
})

test('search finds relevant products in the catalogue, and reads the offers live search missed again', async () => {
  const { db } = freshDb()
  const awei = 'Awei T50 Wireless Headphones Bluetooth 5.3 Earbuds With Mic'
  const at = '2026-11-03T01:00:00Z'
  await recordListings(
    db,
    [
      { ...listing('111', 'daraz', awei, 1100), url: 'https://www.daraz.com.bd/products/awei-t50-i111.html', brand: 'Awei' },
      { ...listing('othoba:826386', 'othoba', awei, 1250), url: 'https://othoba.com/awei-t50-wireless-826386', brand: 'Awei' },
      { ...listing('d2', 'daraz', 'Starship Full Cream Milk Powder - 1kg', 900), brand: 'Starship' },
    ],
    at,
  )
  await matchNewListings(db, at, 10)

  // A typed name is a product here when it says its brand and leaves no choice open.
  const [found] = await findProducts(db, 'Awei T50')
  assert.deepEqual(found.offers.map((o) => o.itemId).sort(), ['111', 'othoba:826386'])
  assert.deepEqual(await findProducts(db, 'T50 earbuds'), [])
  assert.equal((await findProducts(db, 'Starship milk powder 1kg')).length, 1)
  assert.deepEqual(await findProducts(db, 'Starship milk powder'), [])

  // Othoba's search page shows nothing for it today; the catalogue knows its page, read again now.
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://www.daraz.com.bd/catalog')) return Response.json({ mods: { listItems: [{ itemId: '111', name: awei, price: '1100', itemUrl: '//www.daraz.com.bd/products/awei-t50-i111.html' }] } })
    if (url.startsWith('https://othoba.com/search')) return new Response('<html>No products were found</html>')
    if (url === 'https://othoba.com/awei-t50-wireless-826386') {
      const ld = { '@type': 'Product', name: awei, id: '826386', offers: { price: '1199', availability: 'http://schema.org/InStock' } }
      return new Response(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`)
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
  try {
    const answer = await run({ name: 'Awei T50', shops: ['daraz', 'cartup', 'othoba'] }, { PP_DB: db })
    const othoba = answer.stores.find((s) => s.site === 'othoba')!
    assert.equal(othoba.recommended?.listing.itemId, 'othoba:826386')
    assert.equal(othoba.recommended?.listing.price, 1199) // read live, not the ৳1,250 remembered
    assert.equal(answer.catalogue?.name, awei)
    assert.deepEqual(answer.catalogue?.confirmed.sort(), ['111', 'othoba:826386'])
  } finally {
    globalThis.fetch = real
  }
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

test("Star Tech's one listing for every memory version isn't claimed as the version the shopper named", async () => {
  const { db } = freshDb()
  const env = { PP_DB: db, SELF: 'https://dorai.test' }
  const a17 = { ...listing('startech:samsung-galaxy-a17-5g', 'startech', 'Samsung Galaxy A17 5G', 38499), url: 'https://www.startech.com.bd/samsung-galaxy-a17-5g', seller: 'Star Tech', storeRun: true }
  const sized = { ...listing('pickaboo:113244', 'pickaboo', 'Samsung Galaxy A17 5G 8GB/128GB', 42199), seller: 'Pickaboo', storeRun: true }
  const real = globalThis.fetch
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { name } = JSON.parse(String(init?.body)) as { name: string }
    if (name === 'startechSearch') return Response.json({ result: [a17] })
    if (name === 'pickabooSearch') return Response.json({ result: [sized] })
    if (name === 'darazSearch') return Response.json({ result: { listings: [], categories: [], url: 'https://www.daraz.com.bd/catalog/?q=a17' } })
    return Response.json({ result: null })
  }) as typeof fetch
  try {
    for (const name of ['Galaxy A17 5G 8GB/128GB Samsung', 'Samsung Galaxy A17 5G 8GB 128GB']) {
      const answer = await run({ name, details: '' }, env)
      assert.deepEqual(answer.shops, ['daraz', 'startech', 'pickaboo'])
      const startech = answer.stores.find((s) => s.site === 'startech')!
      assert.equal(startech.recommended, null, name)
      assert.match(startech.note ?? '', /memory version/)
      assert.equal(answer.stores.find((s) => s.site === 'pickaboo')?.recommended?.listing.itemId, 'pickaboo:113244')
    }
    // Named without a memory size, the listing is that phone.
    const plain = await run({ name: 'Samsung Galaxy A17 5G', details: '' }, env)
    assert.equal(plain.stores.find((s) => s.site === 'startech')?.recommended?.listing.itemId, 'startech:samsung-galaxy-a17-5g')
  } finally {
    globalThis.fetch = real
  }
})

test('a kind of item: the cards show the same product where the shops sell one, and say so where they don\'t', async () => {
  const { db } = freshDb()
  const env = { PP_DB: db, SELF: 'https://dorai.test' }
  const item = (site: Listing['site'], id: string, name: string, price: number, extra: Partial<Listing> = {}) => ({ ...listing(id, site, name, price), rating: 4.6, reviews: 40, ...extra })
  const daraz = [item('daraz', '1', 'P9 Bluetooth Wireless Gaming Headset With Microphone', 343, { rating: 4.6, reviews: 78 }), item('daraz', '2', 'Logitech G435 Lightspeed Wireless Gaming Headset', 7900)]
  const pickaboo = [item('pickaboo', 'pickaboo:9', 'Logitech G PRO X Gaming Headset with Blue Voice', 14500, { storeRun: true, seller: 'Pickaboo' }), item('pickaboo', 'pickaboo:8', 'Logitech G435 Gaming Headset', 7600, { storeRun: true, seller: 'Pickaboo' })]
  const startech = [item('startech', 'startech:meetion', 'Meetion HP022 Noise-Cancelling RGB Wired Gaming Headset', 850, { storeRun: true, seller: 'Star Tech' })]
  const real = globalThis.fetch
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { name } = JSON.parse(String(init?.body)) as { name: string }
    if (name === 'darazSearch') return Response.json({ result: { listings: daraz, categories: [], url: 'https://www.daraz.com.bd/catalog/?q=gaming+headset' } })
    if (name === 'startechSearch') return Response.json({ result: startech })
    if (name === 'pickabooSearch') return Response.json({ result: pickaboo })
    return Response.json({ result: null })
  }) as typeof fetch
  try {
    const answer = await run({ name: 'gaming headset', details: '' }, env)
    assert.equal(answer.intent.mode, 'need')
    assert.deepEqual(answer.alike?.shops, ['daraz', 'pickaboo'])
    assert.match(answer.alike?.name ?? '', /Logitech G435/)
    const pick = (site: string) => answer.stores.find((s) => s.site === site)!
    assert.equal(pick('daraz').recommended?.listing.itemId, '2')
    assert.equal(pick('pickaboo').recommended?.listing.itemId, 'pickaboo:8')
    assert.ok(pick('pickaboo').matches.some((m) => m.listing.itemId === 'pickaboo:9')) // its own fit moves below
    assert.equal(pick('startech').recommended?.listing.itemId, 'startech:meetion')
    assert.match(pick('startech').note ?? '', /doesn't sell that one/)
  } finally {
    globalThis.fetch = real
  }
})
