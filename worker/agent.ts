/**
 * The agent, as it runs on Cloudflare: one shopper request in, one answer out.
 * Port of ../agent/core.py — same steps, each timed and returned, because
 * "within a very short time" is the product's promise and has to stay
 * measurable:
 *
 *   understand  intent.buildIntent      the product name is taken as typed; only the
 *                                       "what do you need" text goes to Workers AI (~1.5s)
 *   search      daraz.search            ~0.7s, live (the name and the item type in parallel)
 *               cartup.lookup/browse    alongside: its name index + product pages, or its category pages
 *   scope       productCategory+search  only when Daraz's results are mostly noise (~1s)
 *   cartup      cartup.enrich           product pages for the Cartup listings about to be shown
 *   remember    store.lookupHistory     the price last seen, read before this one is recorded
 *   check       eligibility.checkAll    published voucher terms, pure arithmetic
 *
 * Every store gets its own answer (StoreAnswer): its recommended option and
 * why, then its matches. No store's pick is pushed over another's — where
 * both have the same product, each says how its price compares.
 */

import * as cartup from './cartup.ts'
import * as daraz from './daraz.ts'
import * as othoba from './othoba.ts'
import { bestOffer, closestFirst, compareAcross, firstOffer, needWhy, recommendHere, type Result, type StoreAnswer, type StoreMatch, summarize } from './comparison.ts'
import { bestVoucher, checkAll, listingHints } from './eligibility.ts'
import { buildIntent, coreQuery, describeQuery, parseIntent } from './intent.ts'
import { matchRows, relations, type Row, sameProduct, samePicks, sharedPick } from './matching.ts'
import { mainModel, rank } from './ranking.ts'
import * as store from './store.ts'
import type { Env, HistoryMatch, Intent, Listing, Voucher } from './types.ts'

// The engines this orchestrator drives, re-exported for the compare service and the tests.
export { bestOffer, closestFirst, compareAcross, evidence, recommendHere, type Result, type StoreAnswer, type StoreMatch, standing } from './comparison.ts'
export { matchRows, photoId, relations, type Row, sameProduct, sharedPick, UNBRANDED } from './matching.ts'

const MIN_GOOD_RESULTS = 5
const RESULT_LIMIT = 6
const MATCH_LIMIT = 8

export const CAVEATS = [
  'Vouchers are checked against their published terms (dates, minimum spend, cap, badges). Daraz makes the final call at checkout.',
  'Store vouchers and personal vouchers (new-user, Coins) only show to a logged-in Daraz account, so they are not included.',
  'Daraz allows one platform voucher per order, so the best single voucher is shown, not a sum.',
  "Cartup prices and stock are read live from its product pages. Reviews and seller ratings are the ones those pages show; Cartup's hidden search-engine ratings (every product “4.6–5.0 from ~1,300 ratings”) aren't real reviews and are ignored.",
]

export interface Answer {
  query: string
  intent: Intent
  stores: StoreAnswer[]
  summary: string
  checkedAt: string // when these prices were read from the stores (all live, in this answer)
  cartupCategories: string[] // the Cartup category pages browsed
  seen: number // listings Daraz's first search returned
  skippedSuspicious: number
  vouchersKnown: number
  vouchersHarvestedAt: string | null
  database: 'ok' | 'unavailable' | 'not needed'
  caveats: string[]
  timingsMs: Record<string, number>
}

/** Cartup categories for a named product's kind: its describing words, then just the noun ("RGB Mechanical Keyboard" → keyboards). */
function namedKinds(name: string): string[] {
  const d = describeQuery(name)
  if (!d) return []
  const last = d.split(' ').pop()
  return last && last !== d ? [d, last] : [d]
}

export interface AskInput {
  name?: string // a product name (or a kind of item), searched exactly as typed
  details?: string // what they need: features, budget — the only text the AI reads
  query?: string // one-box clients: a name or a description, worked out by the agent
}

export async function run(input: AskInput, env: Env, now = new Date()): Promise<Answer> {
  const t0 = Date.now()
  const timings: Record<string, number> = {}
  let t = t0
  const lap = (name: string) => {
    const n = Date.now()
    timings[name] = n - t
    t = n
  }
  const nowIso = now.toISOString()
  const today = nowIso.slice(0, 10)
  const query = input.query ?? [input.name, input.details].filter(Boolean).join(' — ')

  const intent = input.query !== undefined ? await parseIntent(input.query, env) : await buildIntent(input.name ?? '', input.details ?? '', env)
  lap('understand')

  const named = intent.mode === 'product'
  const db = env.PP_DB
  // A named product is searched with no price filter — they see what they
  // named whatever it costs; the budget goes to the search for alternatives.
  const budget = { minPrice: intent.minPrice, maxPrice: intent.maxPrice }
  // Daraz alternatives: the kind of item from the needs box when given,
  // otherwise from the name's own descriptive words.
  const altQuery = !named
    ? null
    : intent.productType && (intent.mustHave.length > 0 || intent.maxPrice !== null || intent.minPrice !== null)
      ? [intent.brand, intent.productType].filter(Boolean).join(' ')
      : describeQuery(intent.searchQuery)
  // Brand + model code ("Jedel KL69"): Daraz answers the same long title with
  // 7 listings one time and 40 the next; this reliably finds every seller.
  const core = named ? coreQuery(intent.searchQuery) : null
  // A kind of item with a budget: Daraz's first page for "monitor" under ৳30k
  // is mostly ৳3–6k screens, so also look near the budget (50–100% of it).
  // And the kind plus the shopper's describing words ("formal Shirt").
  const nearBudget =
    !named && intent.maxPrice ? { minPrice: Math.max(intent.minPrice ?? 0, Math.round(intent.maxPrice * 0.5)), maxPrice: intent.maxPrice } : null
  const refined = !named ? (intent.refinedQuery ?? null) : null
  const optional = (q: string | null, opts: Parameters<typeof daraz.search>[1] = {}) => (q ? daraz.search(q, opts).catch(() => null) : Promise.resolve(null))

  // Cartup runs alongside: what was typed through its name index, and the
  // kind of item through its category pages (for a named product, its kind's
  // categories give the similar items). A kind of item needs both: Cartup's
  // Radhuni mustard oil is in no "mustard oil" category, and "lotto" has none.
  const kinds = named ? namedKinds(intent.searchQuery) : [intent.refinedQuery, intent.productType, intent.searchQuery].filter((k): k is string => Boolean(k))
  const cartupLookup = cartup.lookup(db, intent.searchQuery)
  const othobaLookup = othoba.lookup(db, intent.searchQuery)
  const cartupBrowse = kinds.length ? cartup.browse(db, kinds) : Promise.resolve(null)
  // Daraz sometimes answers with a bot check instead of results; Cartup still answers then.
  let darazDown = false
  const [first, coreHits, alt, nearHits, refinedHits] = await Promise.all([
    daraz.search(intent.searchQuery, named ? {} : budget).catch(() => {
      darazDown = true
      return { listings: [], categories: [], url: `https://www.daraz.com.bd/catalog/?q=${encodeURIComponent(intent.searchQuery)}` }
    }),
    optional(core),
    optional(altQuery, budget),
    optional(nearBudget ? intent.searchQuery : null, nearBudget ?? {}),
    optional(refined, budget),
  ])
  const extra = alt?.listings ?? []
  const pool = [...new Map([first, coreHits, nearHits, refinedHits].flatMap((r) => r?.listings ?? []).map((l) => [l.itemId, l])).values()]
  let { ranked, alternatives, suspicious } = rank(pool, intent, named ? MATCH_LIMIT + 1 : RESULT_LIMIT, extra)
  let searchUrl = first.url
  // Everything Daraz returned: where each "More" row is matched from.
  let darazAll = [...pool, ...extra]
  lap('search')

  if (ranked.length < MIN_GOOD_RESULTS && ranked.length > 0) {
    // The best real hit's own category (its product page knows it).
    const category = await daraz.productCategory(ranked[0].url).catch(() => null)
    if (category) {
      const scoped = await daraz.search(intent.searchQuery, { category, ...(named ? {} : budget) })
      // Merge, never replace: an oddly filed seed must not hide the first search's hits.
      const merged = new Map([...pool, ...scoped.listings].map((l) => [l.itemId, l]))
      darazAll = [...darazAll, ...scoped.listings]
      const rescored = rank([...merged.values()], intent, named ? MATCH_LIMIT + 1 : RESULT_LIMIT, extra)
      if (rescored.ranked.length > ranked.length) {
        ;({ ranked, alternatives, suspicious } = rescored)
        searchUrl = scoped.url
      }
    }
    lap('scope')
  }

  // Without a model code, rank keeps the titles that match best, whatever
  // they are; the product must still be the one named ("Women's Waist Bag
  // Oxford Cloth" isn't the Air Jordan crossbody chest/waist bag).
  const toName = relations(intent.searchQuery)
  if (named && !mainModel(intent.searchQuery)) ranked = ranked.filter((l) => toName(l) === 'same')

  // ---- Cartup, on its own terms ----
  // For a kind of item, Daraz's pick is looked for on Cartup and searched
  // again on Daraz itself (its other sellers and sizes), while Cartup's own
  // lookups finish.
  const darazPick = named ? null : (ranked[0] ?? null)
  const othobaPickLookup = darazPick ? othoba.lookup(db, darazPick.name) : Promise.resolve(null)
  const [found, browsedRaw, pickLookup, pickHits] = await Promise.all([
    cartupLookup,
    cartupBrowse,
    darazPick ? cartup.lookup(db, darazPick.name) : Promise.resolve(null),
    darazPick ? optional(coreQuery(darazPick.name) ?? darazPick.name.split(/\s+/).slice(0, 6).join(' ')) : Promise.resolve(null),
  ])
  darazAll = [...darazAll, ...(pickHits?.listings ?? [])]
  // Of same-named categories, keep the ones whose listings look like what Daraz found.
  const browsed = browsedRaw ? cartup.likeDaraz(browsedRaw, [...ranked, ...alternatives].slice(0, 10).map((l) => l.name), kinds) : null
  const unique = (ls: Listing[]) => [...new Map(ls.map((l) => [l.itemId, l])).values()]
  // Checked against Daraz's own listing of it, photo included.
  const cartupSame = named && found ? sameProduct(found.listings, intent.searchQuery, ranked[0]) : []
  // Daraz's pick on Cartup: the listing itself and its other sizes.
  const toDarazPick = darazPick ? relations(darazPick.name) : () => null
  const pickOnCartup = (pickLookup?.listings ?? []).filter((l) => ['same', 'variant'].includes(toDarazPick(l) ?? ''))
  let cartupPool = unique([...(found?.listings ?? []), ...(browsed?.listings ?? []), ...pickOnCartup])
  // Category listings carry no seller or reviews: read the product pages of
  // the ones about to be shown before they're ranked or recommended.
  const toShow = (named ? cartupPool.filter((l) => !cartupSame.includes(l) && toName(l) !== null) : rank(cartupPool, intent, RESULT_LIMIT).ranked)
    .filter((l) => !l.seller)
    .slice(0, 4)
  if (toShow.length) {
    const full = new Map((await cartup.enrich(toShow)).map((l) => [l.itemId, l]))
    cartupPool = cartupPool.map((l) => full.get(l.itemId) ?? l)
  }
  const cartupRanked = named ? [] : rank(cartupPool, intent, RESULT_LIMIT).ranked
  const cartupPick = cartupRanked[0] ?? null
  // Cartup's own pick, by name, for its other sellers and sizes — unless it's
  // Daraz's pick, which was just looked up.
  // Daraz searched for it too, as Cartup was for Daraz's pick.
  if (cartupPick && !(darazPick && samePicks(darazPick, cartupPick))) {
    const [own, onDaraz] = await Promise.all([
      cartup.lookup(db, cartupPick.name),
      named ? Promise.resolve(null) : optional(coreQuery(cartupPick.name) ?? cartupPick.name.split(/\s+/).slice(0, 6).join(' ')),
    ])
    cartupPool = unique([...cartupPool, ...own.listings])
    darazAll = [...darazAll, ...(onDaraz?.listings ?? [])]
  }
  lap('cartup')

  // ---- Othoba, through its name index, the same way ----
  const [othobaFound, othobaPickFound] = await Promise.all([othobaLookup, othobaPickLookup])
  const othobaSame = named ? sameProduct(othobaFound.listings, intent.searchQuery, ranked[0]) : []
  const othobaPool = unique([...othobaFound.listings, ...(othobaPickFound?.listings ?? []).filter((l) => ['same', 'variant'].includes(toDarazPick(l) ?? ''))])
  const othobaRanked = named ? [] : rank(othobaPool, intent, RESULT_LIMIT).ranked
  lap('othoba')

  // ---- each store's "More" rows, matched to the product ----
  const needRows = (pick: Listing | null, pool: Listing[], other: { label: string; listing: Listing } | null, fits: Listing[]) =>
    matchRows({ intent, title: pick?.name ?? '', ref: pick, same: [], pool, otherPick: other, fits })
  let darazRows = named
    ? matchRows({ intent, title: intent.searchQuery, ref: ranked[0] ?? null, same: ranked, pool: darazAll })
    : needRows(darazPick, darazAll, cartupPick && { label: 'Cartup', listing: cartupPick }, ranked.slice(1))
  let cartupRows = named
    ? matchRows({ intent, title: intent.searchQuery, ref: cartupSame[0] ?? ranked[0] ?? null, same: cartupSame, pool: cartupPool })
    : needRows(cartupPick, cartupPool, darazPick && { label: 'Daraz', listing: darazPick }, cartupRanked.slice(1))

  // A kind of item: where one store's pick is sold on the other too, both
  // cards show that product, and each store's own pick moves to its "More".
  let darazFit = darazPick
  let cartupFit = cartupPick
  let shared: 'daraz' | 'cartup' | null = null
  const elsewhere = (rows: Row[]) => rows.filter((r) => r.otherStore).map((r) => r.listing)
  if (!named && darazPick && cartupPick && samePicks(darazPick, cartupPick)) {
    // Already the same product: the other store's pick is just another seller of it here.
    for (const r of [...darazRows, ...cartupRows]) if (r.otherStore) Object.assign(r, { relation: 'same', label: 'Same product, another seller', otherStore: undefined })
  } else if (!named && darazPick && cartupPick) {
    const darazPickOnCartup = elsewhere(cartupRows)
    const cartupPickOnDaraz = elsewhere(darazRows)
    const which = sharedPick({ pick: darazPick, elsewhere: darazPickOnCartup }, { pick: cartupPick, elsewhere: cartupPickOnDaraz })
    shared = which === 'a' ? 'daraz' : which === 'b' ? 'cartup' : null
    if (shared === 'daraz') {
      cartupFit = firstOffer(darazPickOnCartup)
      darazRows = needRows(darazPick, darazAll, null, ranked.slice(1))
      cartupRows = needRows(cartupFit, cartupPool, null, [cartupPick, ...cartupRanked.slice(1)])
    } else if (shared === 'cartup') {
      darazFit = firstOffer(cartupPickOnDaraz)
      darazRows = needRows(darazFit, darazAll, null, [darazPick, ...ranked.slice(1)])
      cartupRows = needRows(cartupPick, cartupPool, null, cartupRanked.slice(1))
    }
  }

  // Othoba's card shows the product on Daraz's card when Othoba sells it too, else its own best fit.
  let othobaFit = othobaRanked[0] ?? null
  let othobaShares: string | null = null
  if (!named && darazFit) {
    const onOthoba = sameProduct(othobaPool, darazFit.name, darazFit)
    if (onOthoba.length) {
      othobaFit = firstOffer(onOthoba)
      othobaShares = shared === 'cartup' ? 'Cartup' : 'Daraz'
    }
  }
  const othobaRows = named
    ? matchRows({ intent, title: intent.searchQuery, ref: othobaSame[0] ?? ranked[0] ?? null, same: othobaSame, pool: othobaPool })
    : needRows(othobaFit, othobaPool, othobaShares || !darazFit ? null : { label: 'Daraz', listing: darazFit }, othobaRanked.filter((l) => l !== othobaFit))

  const everything = unique([
    ...ranked,
    ...cartupSame,
    ...cartupRanked,
    ...othobaSame,
    ...othobaRanked,
    ...[...darazRows, ...cartupRows, ...othobaRows].map((r) => r.listing),
  ])
  let history = new Map<string, HistoryMatch>()
  let vouchers: Voucher[] = []
  let harvestedAt: string | null = null
  let database: Answer['database'] = !db ? 'unavailable' : everything.length ? 'ok' : 'not needed'
  if (db) {
    try {
      ;[history, { vouchers, harvestedAt }] = await Promise.all([store.lookupHistory(db, everything), store.loadVouchers(db, today)])
      if (everything.length) await store.recordListings(db, everything, nowIso)
    } catch {
      database = 'unavailable' // the answer must never sink with the database
    }
  }
  lap('remember')

  const results = new Map<string, Result>()
  const toResult = (listing: Listing): Result => {
    const known = results.get(listing.itemId)
    if (known) return known
    const checks = checkAll(vouchers, listing, today)
    const bv = bestVoucher(checks)
    const result = { listing, history: history.get(listing.itemId) ?? null, vouchers: checks, bestVoucher: bv, finalPrice: listing.price - (bv?.saving ?? 0), hints: listingHints(listing) }
    results.set(listing.itemId, result)
    return result
  }
  // The pick's other sellers on its own store, as offers to choose between.
  const offersOf = (rows: Row[]) => rows.filter((r) => r.relation === 'same' && !r.otherStore).map((r) => toResult(r.listing))
  const matchesBesides = (rows: Row[], pick: Result | null): StoreMatch[] =>
    rows
      .filter((r) => r.listing.itemId !== pick?.listing.itemId)
      .slice(0, MATCH_LIMIT)
      .map((r) => ({ ...toResult(r.listing), relation: r.relation, label: r.label }))

  // ---- one answer per store ----
  const darazResults = ranked.map(toResult)
  const darazStore: StoreAnswer = { site: 'daraz', label: 'Daraz', recommended: null, why: null, matches: [], note: null, link: searchUrl }
  if (named) {
    const { pick, why } = recommendHere(darazResults, intent)
    darazStore.recommended = pick
    darazStore.why = why
    darazStore.matches = matchesBesides(darazRows, pick)
    if (!pick)
      darazStore.note = first.listings.length
        ? `No in-stock listing of “${intent.searchQuery}” itself — Daraz's ${first.listings.length} results were accessories, other models, or sold out.`
        : `Nothing on Daraz matched “${intent.searchQuery}” right now.`
  } else {
    const fit = darazFit ? toResult(darazFit) : null
    darazStore.recommended = fit && bestOffer(fit, offersOf(darazRows))
    darazStore.why = fit && needWhy(darazStore.recommended!, intent, fit, shared === 'cartup' ? 'Cartup' : null)
    darazStore.matches = matchesBesides(darazRows, darazStore.recommended)
    if (!darazResults.length) darazStore.note = 'Nothing on Daraz matched what you described right now.'
  }

  const categories = browsed?.categories ?? []
  const cartupStore: StoreAnswer = {
    site: 'cartup',
    label: 'Cartup',
    recommended: null,
    why: null,
    matches: [],
    note: null,
    link: categories[0] ? `https://www.cartup.com/category/${categories[0]}` : null,
  }
  if (named) {
    const same = closestFirst(cartupSame.map(toResult), intent.searchQuery)
    const { pick, why } = recommendHere(same, intent)
    cartupStore.recommended = pick
    cartupStore.why = why
    cartupStore.matches = matchesBesides(cartupRows, pick)
    if (!pick) {
      const why = found?.status === 'no_index' ? "Cartup comparison isn't set up yet." : found?.status === 'error' ? "Couldn't reach Cartup just now." : "Cartup doesn't list this product right now."
      cartupStore.note = cartupStore.matches.length ? `${why} Its closest matches are below.` : why
    }
  } else {
    const fit = cartupFit ? toResult(cartupFit) : null
    cartupStore.recommended = fit && bestOffer(fit, offersOf(cartupRows))
    cartupStore.why = fit && needWhy(cartupStore.recommended!, intent, fit, shared === 'daraz' ? 'Daraz' : null)
    cartupStore.matches = matchesBesides(cartupRows, cartupStore.recommended)
    if (!fit)
      cartupStore.note = categories.length
        ? `Nothing in Cartup's ${categories.map((c) => c.replace(/_\d+$/, '').replace(/_+/g, ' ')).join(' and ')} pages fits what you described.`
        : `Nothing on Cartup is listed as “${intent.searchQuery}”, and it has no section for this kind of item.`
  }

  const othobaStore: StoreAnswer = { site: 'othoba', label: 'Othoba', recommended: null, why: null, matches: [], note: null, link: null }
  const othobaMissing =
    othobaFound.status === 'no_index' ? "Othoba comparison isn't set up yet." : othobaFound.status === 'error' ? "Couldn't reach Othoba just now." : null
  if (named) {
    const { pick, why } = recommendHere(closestFirst(othobaSame.map(toResult), intent.searchQuery), intent)
    othobaStore.recommended = pick
    othobaStore.why = why
    othobaStore.matches = matchesBesides(othobaRows, pick)
    if (!pick) {
      const why = othobaMissing ?? "Othoba doesn't list this product right now."
      othobaStore.note = othobaStore.matches.length ? `${why} Its closest matches are below.` : why
    }
  } else {
    const fit = othobaFit ? toResult(othobaFit) : null
    othobaStore.recommended = fit && bestOffer(fit, offersOf(othobaRows))
    othobaStore.why = fit && needWhy(othobaStore.recommended!, intent, fit, othobaShares)
    othobaStore.matches = matchesBesides(othobaRows, othobaStore.recommended)
    if (!fit) othobaStore.note = othobaMissing ?? `Nothing on Othoba is listed as “${intent.searchQuery}” right now.`
  }

  if (darazDown) darazStore.note = "Couldn't reach Daraz just now — try again in a moment."
  const stores = [darazStore, cartupStore, othobaStore]
  compareAcross(stores)
  // A named product found on the stores: its offers are kept as one product.
  if (named && db && database === 'ok') {
    const offers = stores.flatMap((s) => [s.recommended?.listing, ...s.matches.filter((m) => m.relation === 'same').map((m) => m.listing)])
    await store.linkProduct(db, offers.filter((l): l is Listing => Boolean(l)), nowIso).catch(() => null)
  }
  const summary = summarize(stores)
  lap('check')
  timings.total = Date.now() - t0

  return {
    query,
    intent,
    stores,
    summary,
    checkedAt: nowIso,
    cartupCategories: categories,
    seen: first.listings.length,
    skippedSuspicious: named ? suspicious : 0,
    vouchersKnown: vouchers.length,
    vouchersHarvestedAt: harvestedAt,
    database,
    caveats: CAVEATS,
    timingsMs: timings,
  }
}
