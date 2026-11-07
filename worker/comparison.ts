/**
 * The price comparison engine: for each store, which offer of a product to
 * recommend and why (trusted sellers, real savings, budget), and how the
 * stores' prices compare where they sell the same product.
 */

import { money } from './eligibility.ts'
import { relations, type RowRelation, samePicks, words } from './matching.ts'
import { compact, mainModel, missingWords, storageOf, tokens, trusted } from './ranking.ts'
import type { HistoryMatch, Intent, Listing, VoucherCheck } from './types.ts'

// Below this, leaving the closest-named trusted listing for a cheaper one isn't worth it.
const MIN_SAVING_RATIO = 0.02

export interface Result {
  listing: Listing
  history: HistoryMatch | null
  vouchers: VoucherCheck[]
  bestVoucher: VoucherCheck | null
  finalPrice: number
  hints: string[]
}

export interface StoreMatch extends Result {
  relation: RowRelation // how the row matches the product (see matchRows)
  label: string // the same, in words: "Same product", "Other size or variant", "Same as Cartup's pick"...
}

/** One store's part of the answer. More stores add more of these. */
export interface StoreAnswer {
  site: Listing['site']
  label: string
  recommended: Result | null
  why: string | null
  matches: StoreMatch[]
  note: string | null // why a store has nothing, or what it couldn't do
  link: string | null // the store's own results for this search, when there is one
}

/** Closest title to `name` first (share of its words), then cheapest. */
export function closestFirst(results: Result[], name: string): Result[] {
  const want = new Set(words(name))
  const score = (r: Result) =>
    Math.max(...[r.listing.name, r.listing.alsoNamed].map((n) => (n ? words(n).filter((w) => want.has(w)).length / (want.size || 1) : 0)))
  return [...results].sort((a, b) => score(b) - score(a) || a.finalPrice - b.finalPrice)
}

/** Why a listing counts as trusted, in the words the store itself uses. */
export function standing(l: Listing): string {
  if (l.officialStore) return 'Daraz Mall'
  if (l.storeRun) return `sold by ${l.seller} itself`
  if ((l.rating ?? 0) >= 4 && l.reviews >= 5) return `★ ${l.rating?.toFixed(1)} from ${l.reviews} reviews`
  if (l.sellerPositive) return `seller rated ${l.sellerPositive}% positive`
  return 'no ratings yet'
}

const sameSize = (a: Result, b: Result) => {
  const [x, y] = [storageOf(a.listing.name), storageOf(b.listing.name)]
  return x === null || y === null || x === y
}

/**
 * One store's recommendation for a named product, from its listings of that
 * product (closest title first): the cheapest from a seller worth trusting —
 * unless that's barely cheaper than a trusted closest match — or, with no
 * trusted seller, the closest match, said plainly.
 */
export function recommendHere(same: Result[], intent: Intent): { pick: Result | null; why: string | null } {
  if (!same.length) return { pick: null, why: null }
  const exact = same[0]
  const best = same.filter((r) => trusted(r.listing) && sameSize(r, exact)).sort((a, b) => a.finalPrice - b.finalPrice)[0]
  let pick = exact
  let why: string
  if (best && best !== exact && !(trusted(exact.listing) && best.finalPrice > exact.finalPrice * (1 - MIN_SAVING_RATIO))) {
    pick = best
    why = `The cheapest offer of it here from a seller worth trusting (${standing(best.listing)}).`
    const unrated = same.filter((r) => r.finalPrice < best.finalPrice && !trusted(r.listing)).length
    if (unrated) why += ` ${unrated} cheaper listing${unrated > 1 ? 's' : ''} from sellers without ratings ${unrated > 1 ? 'are' : 'is'} below.`
  } else if (trusted(exact.listing)) {
    why =
      same.length > 1
        ? `Closest match to the name, from a seller worth trusting (${standing(exact.listing)}); no one here has it meaningfully cheaper.`
        : `The only listing of it here (${standing(exact.listing)}).`
  } else {
    why = `Closest match to the name. Its seller has no ratings yet, so check before buying.`
  }
  if (intent.maxPrice !== null && pick.finalPrice > intent.maxPrice) why += ` It's over your ${money(intent.maxPrice)} budget — similar items below may fit.`
  return { pick, why }
}

/** What a listing actually has to go on, whether or not it clears the trust bar ("★ 5.0 from 2 reviews" is not "no ratings"). */
export function evidence(l: Listing): string {
  if (l.officialStore) return 'Daraz Mall'
  if (l.storeRun) return `sold by ${l.seller} itself`
  if (l.rating && l.reviews) return `★ ${l.rating.toFixed(1)} from ${l.reviews} review${l.reviews > 1 ? 's' : ''}`
  if (l.sellerPositive) return `seller rated ${l.sellerPositive}% positive`
  return 'no ratings yet'
}

/** For a kind of item: what made a store's top listing its best fit. */
export function needWhy(pick: Result, intent: Intent, fit: Result = pick, otherStorePick: string | null = null): string {
  const missing = otherStorePick ? [] : missingWords(intent.searchQuery, fit.listing.name)
  const parts = [
    otherStorePick
      ? `${otherStorePick}'s pick, sold here too`
      : missing.length
        ? `No “${missing.join(' ')}” listing here — the best fit for the rest of what you typed`
        : 'Best fit here for what you described',
  ]
  if (fit.listing.matchedFeatures.length) parts.push(`mentions ${fit.listing.matchedFeatures.join(', ')}`)
  parts.push(evidence(pick.listing))
  if (intent.maxPrice !== null) parts.push(`within your ${money(intent.maxPrice)} budget`)
  return parts.join(' · ') + '.' + (pick !== fit ? ` Its cheapest offer here from a seller worth trusting (${standing(pick.listing)}).` : '')
}

/**
 * For a kind of item, the best fit is a product; what's recommended is its
 * best offer here: the cheapest from a seller worth trusting, when that's a
 * real saving (the MX Master 3S from Daraz Mall at ৳11,999, not ৳15,000 from
 * a seller with two reviews).
 */
export function bestOffer(fit: Result, offers: Result[]): Result {
  const cheaper = offers.filter((r) => trusted(r.listing) && sameSize(r, fit) && r.finalPrice < fit.finalPrice * (1 - MIN_SAVING_RATIO))
  return cheaper.sort((a, b) => a.finalPrice - b.finalPrice)[0] ?? fit
}

/** Of one product's listings on a store, the one to show: a seller worth trusting, then the cheapest. */
export const firstOffer = (listings: Listing[]): Listing => [...listings].sort((x, y) => Number(trusted(y)) - Number(trusted(x)) || x.price - y.price)[0]

/** Where two stores' picks are the same product, each says how its price compares — a fact, not a push. */
export function compareAcross(stores: StoreAnswer[]): void {
  for (const a of stores) {
    for (const b of stores) {
      if (a === b || !a.recommended || !b.recommended) continue
      if (!samePicks(a.recommended.listing, b.recommended.listing)) continue
      const diff = a.recommended.finalPrice - b.recommended.finalPrice
      const fact = diff === 0 ? `Same price as on ${b.label}.` : `${money(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than on ${b.label}.`
      a.why = a.why ? `${a.why} ${fact}` : fact
    }
  }
}

export interface HotDeal {
  site: Listing['site']
  label: string
  itemId: string
  name: string
  url: string
  price: number // what it costs, after the best public voucher when one applies
  voucher: string | null
  sameProduct: boolean // true: `rival` sells this very product. false: the stores' picks are different products
  rival: { label: string; price: number } // the next cheapest of those stores
  saving: number // less than the rival
  stores: number // picks compared, this one included
}

/**
 * The lowest price of the stores' picks, which the page shows burning. It
 * only says what's true: at least two stores' in-stock picks to compare,
 * every store checked (one that couldn't be reached may be cheaper), and one
 * clear winner (a tie has none). `sameProduct` tells a real saving on one
 * product from the cheapest of several different ones: for "bench" a ৳4,000
 * garden bench isn't "৳4,000 less" than a ৳8,000 gym bench. A named product
 * is the same product on every store by the time it's a store's pick.
 */
export function hotDeal(stores: StoreAnswer[], named: boolean): HotDeal | null {
  if (stores.some((s) => s.note?.startsWith("Couldn't reach"))) return null
  const offers = stores
    .flatMap((store) => (store.recommended?.listing.inStock ? [{ store, pick: store.recommended }] : []))
    .sort((a, b) => a.pick.finalPrice - b.pick.finalPrice)
  const [best, ...rest] = offers
  if (!rest.length || rest[0].pick.finalPrice === best.pick.finalPrice) return null
  const sameAsBest = rest.filter((o) => named || samePicks(best.pick.listing, o.pick.listing))
  const rival = sameAsBest[0] ?? rest[0]
  const { listing } = best.pick
  return {
    site: best.store.site,
    label: best.store.label,
    itemId: listing.itemId,
    name: listing.name,
    url: listing.url,
    price: best.pick.finalPrice,
    voucher: best.pick.bestVoucher?.voucher.title ?? null,
    sameProduct: sameAsBest.length > 0,
    rival: { label: rival.store.label, price: rival.pick.finalPrice },
    saving: Math.round((rival.pick.finalPrice - best.pick.finalPrice) * 100) / 100,
    stores: offers.length,
  }
}

export function summarize(stores: StoreAnswer[]): string {
  return stores
    .map((s) => (s.recommended ? `${s.label}: ${s.recommended.listing.name} at ${money(s.recommended.finalPrice)} from ${s.recommended.listing.seller || s.label}.` : `${s.label}: ${s.note ?? 'nothing found.'}`))
    .join(' ')
}

/**
 * A kind of item on several shops: each shop's own best fit can be a
 * different product at a different price (a ৳343 Bluetooth headphone, a
 * ৳14,500 Logitech G PRO X), which isn't a comparison. This finds the product
 * among the shops' top fits that the most of the shops shown sell, at least
 * two, and where each sells it. Only the top few fits are tried, against each
 * shop's own listings, to keep within the CPU a request has.
 */
export function alikeAcross(shops: string[], fitsOf: Record<string, Listing[]>, poolOf: Record<string, Listing[]>, perShop = 3): { anchor: Listing; on: Record<string, Listing[]> } | null {
  let best: { anchor: Listing; on: Record<string, Listing[]>; score: number } | null = null
  // Each shop's listings once, in stock.
  const pools = Object.fromEntries(shops.map((site) => [site, [...new Map((poolOf[site] ?? []).filter((l) => l.inStock).map((l) => [l.itemId, l])).values()]]))
  for (const home of shops) {
    ;(fitsOf[home] ?? []).slice(0, perShop).forEach((candidate, rank) => {
      // The full comparison is slow, so a listing must first share the
      // candidate's model code, or most of its words, to be compared at all.
      const model = mainModel(candidate.name)
      const want = [...new Set(tokens(candidate.name).filter((w) => w.length > 2))]
      const near = (l: Listing) =>
        model ? compact(l.name).includes(model) : want.filter((w) => tokens(l.name).includes(w)).length >= Math.ceil(want.length * 0.6)
      // The candidate's title is worked out once, then each near listing judged against it.
      const relate = relations(candidate.name, candidate)
      const on: Record<string, Listing[]> = {}
      for (const site of shops) {
        const here = pools[site].filter((l) => l.itemId === candidate.itemId || (near(l) && relate(l) === 'same'))
        if (here.length) on[site] = here
      }
      // Most shops first, then the better-ranked fit.
      const score = Object.keys(on).length * 100 - rank
      if (Object.keys(on).length >= 2 && (!best || score > best.score)) best = { anchor: candidate, on, score }
    })
  }
  const found = best as { anchor: Listing; on: Record<string, Listing[]> } | null // set inside the loop's callbacks
  return found && { anchor: found.anchor, on: found.on }
}
