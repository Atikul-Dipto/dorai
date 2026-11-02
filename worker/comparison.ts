/**
 * The price comparison engine: for each store, which offer of a product to
 * recommend and why (trusted sellers, real savings, budget), and how the
 * stores' prices compare where they sell the same product.
 */

import { money } from './eligibility.ts'
import { type RowRelation, samePicks, words } from './matching.ts'
import { missingWords, storageOf, trusted } from './ranking.ts'
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

export function summarize(stores: StoreAnswer[]): string {
  return stores
    .map((s) => (s.recommended ? `${s.label}: ${s.recommended.listing.name} at ${money(s.recommended.finalPrice)} from ${s.recommended.listing.seller || s.label}.` : `${s.label}: ${s.note ?? 'nothing found.'}`))
    .join(' ')
}
