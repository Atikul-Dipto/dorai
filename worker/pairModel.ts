/**
 * The same-product model: how likely two listings are one product, learned
 * from labelled pairs (data/matching/labels.txt) instead of hand-set points.
 *
 * The hard rules in catalog.ts `confidence` still come first: another brand,
 * model, size, storage, variant, bundle... is another product, and those
 * pairs never reach the model. For the rest, each pair is described by the
 * clues below and a logistic regression weighs them (scripts/train-matcher.ts
 * fits the weights, pairWeights.ts holds them). It costs well under a
 * millisecond a pair, so it runs wherever `confidence` does.
 */

import { type Parsed, confidence } from './catalog.ts'
import { WEIGHTS } from './pairWeights.ts'

/** What a pair's two listings are, beyond their parsed titles. */
export interface PairSide {
  name: string
  parsed: Parsed
  price: number | null
  site: string
}

// Words that make one listing a different product from an otherwise identical one.
const FLAVOURS = new Set(
  ('rose lemon lime orange strawberry chocolate vanilla mango lavender jasmine citrus floral aloe neem sandal sandalwood apple banana coffee mint menthol ' +
    'cherry apricot plum oud orchid freesia juniper almond honey coconut olive cactus amla onion argan berry blueberry grape watermelon pineapple tangerine ' +
    'masala cheese carbonara chicken beef tuna shrimp vanila caramel cocoa sakura lily violet ocean breeze musk spicy original classic').split(' '),
)
const MEN = new Set(['men', 'mens', 'man', 'male', 'boys', 'boy', 'gents', 'gent'])
const WOMEN = new Set(['women', 'womens', 'woman', 'female', 'ladies', 'lady', 'girls', 'girl'])
// Words that make a listing something for the product rather than the product: a case for a phone, a refill for a machine.
const ACCESSORY = new Set(
  'case cases cover covers protector tempered guard refill refills spare parts replacement strap straps sticker skin pouch adapter charger cable cord comb holder stand mount'.split(' '),
)
const COPY = new Set(['copy', 'inspired', 'replica', 'clone'])
const PACKING = new Set(['pack', 'packs', 'combo', 'pcs', 'pieces', 'piece', 'pair', 'pairs', 'set', 'twin', 'family', 'buy', 'free', 'bundle'])

// Words that name one version of a product: a Bangla keyboard, a half-sleeve jersey, a charger with "plug only".
const VERSION = new Set(
  'bangla english arabic half full short long only ii iii 2nd 3rd 4th gen generation edition plus pro max mini lite ultra se neo prime kids adult'.split(' '),
)
// How many of it a listing is: "(3-Pack)", "2X …", "4 pcs", "1 pair".
const COUNT_RE = /(?:^|[^\d.])(\d{1,3})\s*-?\s*(?:pack|packs|pcs|pc|pieces|piece|pairs?|units?)\b|^\s*(\d{1,2})\s*x\s/gi
const countsOf = (name: string) => new Set([...name.matchAll(COUNT_RE)].map((m) => Number(m[1] ?? m[2])).filter((n) => n > 0))

const has = (words: Set<string>, list: Set<string>) => [...words].some((w) => list.has(w))
const only = (mine: Set<string>, theirs: Set<string>) => [...mine].filter((w) => !theirs.has(w))

/** The clues for one pair, by name. Names are what the weights are keyed by. */
export function pairFeatures(a: PairSide, b: PairSide, samePhoto: boolean): Record<string, number> {
  const [x, y] = [a.parsed, b.parsed]
  const ta = new Set(x.title.split(' ').filter(Boolean))
  const tb = new Set(y.title.split(' ').filter(Boolean))
  const [wa, wb] = [new Set(x.words), new Set(y.words)]
  const both = [...wa].filter((w) => wb.has(w)).length
  const onlyA = only(ta, tb)
  const onlyB = only(tb, ta)
  const sideHas = (list: Set<string>) => [onlyA.some((w) => list.has(w)), onlyB.some((w) => list.has(w))]
  const [flavA, flavB] = sideHas(FLAVOURS)
  const [accA, accB] = sideHas(ACCESSORY)
  const [copyA, copyB] = sideHas(COPY)
  const [packA, packB] = sideHas(PACKING)
  const numbers = (ws: string[]) => ws.filter((w) => /\d/.test(w))
  const [numA, numB] = [numbers(onlyA).length, numbers(onlyB).length]
  const codes = (ws: string[]) => ws.filter((w) => w.length >= 3 && /[a-z]/.test(w) && /\d/.test(w))
  const [ca, cb] = [countsOf(a.name), countsOf(b.name)]
  const counted = (s: Set<number>) => [...s].some((n) => n > 1)
  const model =
    x.model && y.model ? (x.model === y.model ? 'same' : 'different') : x.model || y.model ? 'one' : 'none'
  const rules = confidence(x, y, samePhoto)
  const gap = a.price && b.price ? Math.abs(Math.log(a.price / b.price)) : 0
  return {
    rules: rules.score,
    brandSame: x.brand && y.brand ? 1 : 0, // the rules already refused different brands
    brandNone: !x.brand && !y.brand ? 1 : 0,
    modelSame: model === 'same' ? 1 : 0,
    modelOne: model === 'one' ? 1 : 0,
    jaccard: both / (new Set([...wa, ...wb]).size || 1),
    cover: both / (Math.min(wa.size, wb.size) || 1),
    extraFew: Math.min(onlyA.length, onlyB.length) / 5,
    extraMany: Math.max(onlyA.length, onlyB.length) / 10,
    identical: x.title === y.title ? 1 : 0,
    samePhoto: samePhoto ? 1 : 0,
    sizeBoth: x.specs.size.length && y.specs.size.length ? 1 : 0,
    sizeOne: (x.specs.size.length > 0) !== (y.specs.size.length > 0) ? 1 : 0,
    priceGap: Math.min(gap, 3),
    priceMissing: a.price && b.price ? 0 : 1,
    flavourBoth: flavA && flavB ? 1 : 0, // each names a flavour or scent the other doesn't: Rose vs Lemon
    flavourOne: flavA !== flavB ? 1 : 0,
    gender: (has(ta, MEN) && has(tb, WOMEN)) || (has(ta, WOMEN) && has(tb, MEN)) ? 1 : 0,
    accessoryOne: accA !== accB ? 1 : 0, // a case against a phone
    copyOne: copyA !== copyB ? 1 : 0,
    packingOne: packA !== packB ? 1 : 0,
    numbersBoth: numA && numB ? 1 : 0, // 2858 against 9931, 32 pcs against 34
    numbersOne: (numA > 0) !== (numB > 0) ? 1 : 0,
    codesBoth: codes(onlyA).length && codes(onlyB).length ? 1 : 0, // HWM80-1269S6 against HWM80-316S6
    countDiff: ca.size && cb.size && [...ca].sort().join() !== [...cb].sort().join() ? 1 : 0, // 3-pack against 2-pack
    countOne: counted(ca) !== counted(cb) && !(ca.size && cb.size) ? 1 : 0, // "2X …" against the single one
    versionOne: sideHas(VERSION).some(Boolean) ? 1 : 0,
    sameSite: a.site === b.site ? 1 : 0,
    short: Math.min(wa.size, wb.size) <= 2 ? 1 : 0, // "Bluetooth music receiver": too few words to tell
  }
}

export const FEATURES = Object.keys(WEIGHTS.coef)

/** How likely the pair is one product, 0 to 1. A pair the hard rules refuse is 0. */
export function sameProbability(a: PairSide, b: PairSide, samePhoto = false): number {
  const f = pairFeatures(a, b, samePhoto)
  if (f.rules === 0) return 0
  let z = WEIGHTS.intercept
  for (const name of FEATURES) z += WEIGHTS.coef[name] * (((f[name] ?? 0) - WEIGHTS.mean[name]) / WEIGHTS.scale[name])
  return 1 / (1 + Math.exp(-z))
}
