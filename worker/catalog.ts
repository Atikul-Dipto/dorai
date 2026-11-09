/**
 * The product matching engine's catalogue: every listing DorAI records is
 * matched to one canonical product, stage by stage (docs/ARCHITECTURE.md):
 *
 *   store listing → extract brand and model → normalize the title
 *     → extract specifications → product fingerprint → existing product?
 *        no  → create a new canonical product
 *        yes → hard rules and confidence score (a shortlist)
 *            → the same-product model (pairModel.ts), 0 to 1
 *                 → high (≥ MODEL.sameFrom)        → automatic match (linked)
 *                 → in between                     → manual review (/review)
 *                 → low (< MODEL.differentBelow)   → a new canonical product
 *
 * It runs in the scheduled jobs (jobs/index.ts), a batch of unprocessed
 * listings per run; a listing whose name changes is processed again. Answers
 * don't wait for it: they match live (matching.ts) in a couple of seconds.
 * Search asks it what a named product is (findProducts), for the offers it
 * already knows on every store.
 */

import { COLOURS, photoFile, SALES_TALK, STOP, UNBRANDED } from './matching.ts'
import { cleanText } from './normalize.ts'
import { type PairSide, sameProbability } from './pairModel.ts'
import { WEIGHTS } from './pairWeights.ts'
import { amountOf, holdsCode, isBundle, isNetworkGen, modelTokens, QUANTITY_RE, storageOf, tokens, variantsOf } from './ranking.ts'
import type { D1Database, D1Statement, Listing } from './types.ts'

/** A listing as the catalogue reads it from D1 `listings`. */
export interface StoredListing {
  item_id: string
  site: string
  name: string
  brand: string | null
  image: string | null
}

export interface Specs {
  size: string[] // "1kg", "500ml", "2pcs": amounts in one spelling
  storage: number | null // GB
  variant: string // "plus pro", from variantsOf
  network: string | null // "5g"
  colour: string | null // shown, never a conflict: colours of one product are one product to compare
  bundle: boolean
  dims: string[] // "3x3": a cube's, a frame's
  times: string | null // "3x": Samyang's 2x and 3x Spicy, a remedy's potency
  volume: string | null // "4" in "Vol. 4": one book of a series
  capacity: string[] // a battery's "20000mah": a 10000mAh power bank is another product
}

export interface Parsed {
  brand: string | null // normalized: "starship", "just for baby"
  brandFrom: 'store' | 'title' | null
  model: string | null // the main model code: "kl69", "a36", "wh1000xm5"
  title: string // the normalized title
  words: string[] // identity words: the title less brand, model, amounts, colours and filler
  specs: Specs
  photo: string | null
  fingerprint: string
}

// A title's first word that names no brand: "Wireless Earbuds…", "Original Starship…".
const GENERIC_FIRST = new Set([
  'new', 'original', 'best', 'premium', 'smart', 'mini', 'portable', 'wireless', 'professional', 'digital', 'electric', 'automatic', 'high', 'super',
  'pure', 'fresh', 'hot', 'combo', 'pack', 'set', 'kids', 'baby', 'men', 'mens', 'women', 'womens', 'ladies', 'stylish', 'fashion', 'luxury', 'trendy',
  'classic', 'genuine', 'authentic', 'imported', 'local', 'organic', 'natural', 'special', 'exclusive', 'latest', 'unique', 'multi', 'multifunctional',
  'universal', 'cotton', 'leather', 'stainless', 'plastic', 'wooden', 'rechargeable', 'waterproof', 'bluetooth', 'gaming', 'led', 'usb', 'tws', 'buy', 'get',
  'mobile', 'phone', 'laptop', 'computer', 'outdoor', 'indoor', 'indian', 'chinese', 'casual', 'sports', 'sport', 'winter', 'summer', 'cute', 'soft', 'cool',
  'big', 'small', 'large', 'heavy', 'folding', 'foldable', 'adjustable', 'magnetic', 'hair', 'face', 'body', 'kitchen', 'home', 'car', 'bike', 'travel',
  'gift', 'designer', 'handmade', 'printed', 'product', 'products', 'pure', 'instant',
])

// Letters with accents as plain letters ("Nestlé" → "nestle"); tokens() reads only a–z and 0–9.
const plain = (s: string) => cleanText(s).normalize('NFD').replace(/[̀-ͯ]/g, '')

/**
 * A title's model code: its first real code, letters and digits in one word
 * ("RB40" in "SmarToools RB40 AA 1.5V… (4/2 Pcs Set)", "L1504FA" in "Asus
 * Vivobook Go 15 L1504FA…"), else a code made of a short prefix and a number
 * ("WH-1000XM5"), else a word and a number of 2+ digits ("iPhone 15", "Nokia
 * 215") — "Battery 4", "Powder 0+" and "pack (100%" are no models, nor are
 * multipliers, dimensions and styles ("2x", "3D", "4K", a cube's "3x3", "Y2K"
 * tees: every 3x3 cube had the same "model"). The live matcher picks the
 * longest code instead, which can be a spec ("lightweight44").
 */
const NOT_A_LINE = new Set(['pack', 'set', 'size', 'version', 'combo', 'day', 'days', 'year', 'years', 'month', 'hour', 'hours', 'piece', 'pieces', 'pcs', 'in', 'of'])
const NOT_A_MODEL = new Set(['y2k', 'mp3', 'mp4', 'mp5'])
const DIMENSION = /^\d+x\d+(x\d+)?$/
export function catalogModel(name: string): string | null {
  const ts = tokens(plain(name))
  const codes = modelTokens(ts)
  const glued = (c: string) => {
    const word = /^[a-z]+/.exec(c)?.[0] ?? ''
    return !ts.includes(c) && !NOT_A_LINE.has(word) && !GENERIC_FIRST.has(word) && !STOP.has(word)
  }
  return (
    codes.find((c) => ts.includes(c) && /[a-z]/.test(c) && /\d/.test(c) && c.length >= 3 && !/^\d+[xdkgp]$/.test(c) && !DIMENSION.test(c) && !NOT_A_MODEL.has(c)) ??
    codes.find((c) => glued(c) && /^[a-z]{1,3}\d+([a-z]|\d{2})/.test(c)) ??
    codes.find((c) => glued(c) && /^[a-z]{2,}\d{2,}$/.test(c)) ??
    null
  )
}

// ---- 1. Extract brand and model ----

/** The store's brand when it names one, else the title's first word when that isn't a generic one; and the model code. */
export function extractBrandModel(name: string, storeBrand: string | null): Pick<Parsed, 'brand' | 'brandFrom' | 'model'> {
  const model = catalogModel(name)
  const fromStore = tokens(plain(storeBrand ?? '')).join(' ')
  if (fromStore && !UNBRANDED.test((storeBrand ?? '').trim())) return { brand: fromStore, brandFrom: 'store', model }
  const first = tokens(plain(name)).find((t) => !STOP.has(t))
  if (first && /^[a-z]{2,}$/.test(first) && !GENERIC_FIRST.has(first) && !COLOURS.has(first)) return { brand: first, brandFrom: 'title', model }
  return { brand: null, brandFrom: null, model }
}

// ---- 2. Normalize the product title ----

/** One spelling of a title: lower case, no punctuation, amounts in one unit ("1 Kg", "1000gm" → "1000g"), no filler. */
export function normalizeTitle(name: string): string {
  const text = plain(name)
    .toLowerCase()
    .replace(new RegExp(QUANTITY_RE.source, 'gi'), (_, n: string, u: string) => ` ${amountOf(n, u)} `)
  return tokens(text)
    .filter((t) => !STOP.has(t) && !SALES_TALK.has(t))
    .join(' ')
}

// ---- 3. Extract specifications ----

const TIMES = /^\d+x$/
const CAPACITY_RE = /\b(\d{1,3}(?:,\d{3})+|\d{3,6})\s*mah\b/gi
const WATTAGE_RE = /\b\d+(?:\.\d+)?\s*(?:w|watt|watts)\b/gi
const VOLUME_RE = /\b(?:vol(?:ume)?|part|book|season|chapter|issue)\s*[.:#-]?\s*(\d+)\b/i

export function extractSpecs(name: string, model: string | null): Specs {
  const title = normalizeTitle(name)
  const ts = title.split(' ')
  const sizeRe = /^\d+(\.\d+)?(kg|g|l|ml|pcs|pack)$/
  return {
    size: [...new Set(ts.filter((t) => sizeRe.test(t) && !isNetworkGen(t)))].sort(),
    storage: storageOf(name),
    variant: variantsOf(name, model ?? undefined),
    network: ts.find((t) => isNetworkGen(t)) ?? null,
    colour: ts.find((t) => COLOURS.has(t)) ?? null,
    bundle: isBundle(name),
    dims: [...new Set(ts.filter((t) => DIMENSION.test(t)))].sort(),
    times: ts.find((t) => TIMES.test(t)) ?? null,
    volume: VOLUME_RE.exec(plain(name))?.[1].replace(/^0+(?=\d)/, '') ?? null,
    capacity: [...new Set([...plain(name).matchAll(CAPACITY_RE)].map((m) => `${Number(m[1].replace(/,/g, ''))}mah`))].sort(),
  }
}

// ---- 4. Generate the product fingerprint ----

/** Brand + model + specs; without a model code, brand + identity words + specs. Equal fingerprints describe one product. */
export function fingerprint(p: Omit<Parsed, 'fingerprint'>): string {
  const s = p.specs
  // A capacity only adds to the fingerprints of listings that state one, so the others stay as they were.
  const specs = [s.size.join('+'), s.storage ?? '', s.variant, s.network ?? '', s.bundle ? 'bundle' : '', s.dims.join('+'), s.times ?? '', s.volume ?? '', ...(s.capacity?.length ? [s.capacity.join('+')] : [])].join('|')
  return p.model ? `m|${p.brand ?? ''}|${p.model}|${specs}` : `w|${p.brand ?? ''}|${[...new Set(p.words)].sort().join('+')}|${specs}`
}

/** Whether a fingerprint names a brand or a model code: then equal ones are one product. "Bluetooth music receiver" twice may be two. */
const telling = (fp: string) => fp.startsWith('m|') || fp.split('|')[1] !== ''

/** Stages 1–4 for one listing. */
export function parseListing(name: string, storeBrand: string | null, image: string | null): Parsed {
  const { brand, brandFrom, model } = extractBrandModel(name, storeBrand)
  const title = normalizeTitle(name)
  const specs = extractSpecs(name, model)
  const skip = new Set([...(brand?.split(' ') ?? []), ...specs.size, ...specs.dims, ...(specs.times ? [specs.times] : []), ...(specs.network ? [specs.network] : []), ...COLOURS])
  // A battery's capacity is a spec of its own, and a wattage is spelled every
  // way ("22.5 Watt", "22.5W"): as words they'd only make one product look like two.
  const powerless = normalizeTitle(name.replace(CAPACITY_RE, ' ').replace(WATTAGE_RE, ' ')).split(' ')
  const words = powerless.filter((t) => t && !skip.has(t) && !(model && model.includes(t) && /\d/.test(t)) && t !== model)
  const parsed = { brand, brandFrom, model, title, words, specs, photo: photoFile(image) }
  return { ...parsed, fingerprint: fingerprint(parsed) }
}

// ---- 5. Confidence score and level ----

export type Level = 'high' | 'medium' | 'low' | 'none'
export const LEVELS = { high: 0.8, medium: 0.6, low: 0.4 }

export function levelOf(score: number): Level {
  return score >= LEVELS.high ? 'high' : score >= LEVELS.medium ? 'medium' : score >= LEVELS.low ? 'low' : 'none'
}

const jaccard = (a: string[], b: string[]) => {
  const [x, y] = [new Set(a), new Set(b)]
  const both = [...x].filter((w) => y.has(w)).length
  return both / (new Set([...x, ...y]).size || 1)
}

/**
 * How sure the engine is that listing `a` is product `b`, from 0 to 1, with
 * the reasons. A hard conflict (another brand, model, size, storage,
 * variant, network, dimensions, strength or volume, or a bundle against a
 * single item) is 0: those are other products, however alike the words.
 * `typed`: `a` is what a shopper typed, not a listing — they type fewer words
 * than sellers, so the words count by how much of it `b`'s title holds.
 */
export function confidence(a: Parsed, b: Parsed, samePhoto = false, typed = false): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const aTokens = a.title.split(' ')
  const bTokens = b.title.split(' ')
  const brandIn = (brand: string, ts: string[]) => brand.split(' ').every((w) => ts.includes(w))
  const brand = !a.brand || !b.brand ? 'unknown' : a.brand === b.brand || brandIn(a.brand, bTokens) || brandIn(b.brand, aTokens) ? 'same' : 'different'
  if (brand === 'different') return { score: 0, reasons: [`different brand (${a.brand} / ${b.brand})`] }
  const model =
    a.model && b.model ? (a.model === b.model ? 'same' : 'different') : a.model || b.model ? (holdsCode(b.title, a.model ?? '') || holdsCode(a.title, b.model ?? '') ? 'held' : 'one') : 'none'
  if (model === 'different') return { score: 0, reasons: [`different model (${a.model} / ${b.model})`] }
  const [x, y] = [a.specs, b.specs]
  if (x.size.length && y.size.length && x.size.join('+') !== y.size.join('+')) return { score: 0, reasons: [`different size (${x.size.join(', ')} / ${y.size.join(', ')})`] }
  if (x.storage !== null && y.storage !== null && x.storage !== y.storage) return { score: 0, reasons: [`different storage (${x.storage} / ${y.storage} GB)`] }
  if (x.variant !== y.variant && (x.variant || y.variant)) return { score: 0, reasons: [`different variant (${x.variant || 'none'} / ${y.variant || 'none'})`] }
  if (x.network && y.network && x.network !== y.network) return { score: 0, reasons: [`different network (${x.network} / ${y.network})`] }
  if (x.bundle !== y.bundle) return { score: 0, reasons: ['one is a bundle'] }
  if (x.dims.length && y.dims.length && x.dims.join('+') !== y.dims.join('+')) return { score: 0, reasons: [`different dimensions (${x.dims.join(', ')} / ${y.dims.join(', ')})`] }
  if (x.times && y.times && x.times !== y.times) return { score: 0, reasons: [`different strength (${x.times} / ${y.times})`] }
  if (x.volume && y.volume && x.volume !== y.volume) return { score: 0, reasons: [`different volume (${x.volume} / ${y.volume})`] }
  if (x.capacity?.length && y.capacity?.length && x.capacity.join('+') !== y.capacity.join('+'))
    return { score: 0, reasons: [`different capacity (${x.capacity.join(', ')} / ${y.capacity.join(', ')})`] }

  let score = 0
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(reason)
  }
  if (brand === 'same') add(0.3, 'same brand')
  else add(0.1, 'brand unknown on one side')
  // The same brand and model code, with no spec in conflict, is the product (0.80): "AWEI T50 TWS…
  // Docking Station" is the Awei T50. Without a code, the same brand, all the same words and size is.
  if (model === 'same') add(0.5, `same model (${a.model})`)
  else if (model === 'held') add(0.3, 'model code in the other title')
  const overlap = typed ? aTokens.filter((t) => bTokens.includes(t)).length / (aTokens.length || 1) : jaccard(a.words, b.words)
  add(overlap * (model === 'same' ? 0.2 : 0.45), typed ? `${Math.round(overlap * 100)}% of the words typed` : `${Math.round(overlap * 100)}% of the words in common`)
  if ((x.size.length && y.size.length) || (x.storage !== null && y.storage !== null) || (x.dims.length && y.dims.length)) add(0.1, 'same size')
  if (a.title === b.title && aTokens.length >= 5) add(0.25, 'identical title')
  if (samePhoto) add(0.45, 'same photo file')
  return { score: Math.round(Math.min(1, score) * 100) / 100, reasons }
}

// ---- 6. The pipeline over the database ----

interface ProductRow {
  id: number
  name: string
  brand: string | null
  image: string | null
}

/**
 * Existing products this listing could be: the same fingerprint, model code
 * or photo file, or the same brand with one of its three longest identity
 * words ("powder" finds Starship's milk powder for "Starship Instant…").
 */
async function candidates(db: D1Database, p: Parsed, itemId: string): Promise<{ row: ProductRow; samePhoto: boolean }[]> {
  const photoProducts = p.photo
    ? (await db.prepare(`SELECT DISTINCT product_id AS id FROM listings WHERE photo_id = ? AND product_id IS NOT NULL AND item_id != ?`).bind(p.photo, itemId).all<{ id: number }>()).results.map((r) => r.id)
    : []
  const [w1, w2, w3] = [...new Set(p.words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map((w) => `% ${w} %`)
  const { results } = await db
    .prepare(
      `SELECT id, name, brand, image FROM products
        WHERE id IN (SELECT product_id FROM listings WHERE fingerprint = ?1 AND product_id IS NOT NULL AND item_id != ?2)
           OR (?3 IS NOT NULL AND model = ?3)
           OR (?4 IS NOT NULL AND brand_key = ?4 AND ((' ' || words || ' ') LIKE ?5 OR (' ' || words || ' ') LIKE ?6 OR (' ' || words || ' ') LIKE ?7))
           OR id IN (SELECT value FROM json_each(?8))
        LIMIT 40`,
    )
    .bind(p.fingerprint, itemId, p.model, p.brand, w1 ?? null, w2 ?? null, w3 ?? null, JSON.stringify(photoProducts))
    .all<ProductRow>()
  return results.map((row) => ({ row, samePhoto: photoProducts.includes(row.id) }))
}

async function createProduct(db: D1Database, l: StoredListing, p: Parsed, now: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO products (name, brand, brand_key, model, words, fingerprint, photo_id, image, specs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(l.name, l.brand, p.brand, p.model, p.words.join(' '), p.fingerprint, p.photo, l.image, JSON.stringify(p.specs), now, now)
    .first<{ id: number }>()
  return row!.id
}

/**
 * Where the model's score decides. Measured out of fold on 1,049 labelled
 * pairs (scripts/train-matcher.ts): links from `sameFrom` up were 95.9% right,
 * and 93% of pairs under `differentBelow` were different products.
 */
export const MODEL = { sameFrom: WEIGHTS.autoThreshold, differentBelow: 0.2 }

/** The listing's last price, and each candidate product's founding listing's store and last price: the model weighs the price gap. */
async function sidesOf(db: D1Database, itemId: string, productIds: number[]): Promise<{ own: number | null; products: Map<number, { site: string; price: number | null }> }> {
  const last = `(SELECT price FROM price_history WHERE item_id = l.item_id ORDER BY seen_at DESC LIMIT 1)`
  const [own, others] = await Promise.all([
    db.prepare(`SELECT ${last} AS price FROM listings l WHERE l.item_id = ?`).bind(itemId).first<{ price: number | null }>(),
    productIds.length
      ? db
          .prepare(`SELECT l.product_id AS id, l.site, ${last} AS price FROM listings l WHERE l.product_id IN (SELECT value FROM json_each(?)) AND l.match_status = 'new'`)
          .bind(JSON.stringify(productIds))
          .all<{ id: number; site: string; price: number | null }>()
      : Promise.resolve({ results: [] as { id: number; site: string; price: number | null }[] }),
  ])
  return { own: own?.price ?? null, products: new Map(others.results.map((r) => [r.id, { site: r.site, price: r.price }])) }
}

export type Outcome = 'new' | 'auto' | 'review' | 'manual'

/** One listing through the whole pipeline. */
export async function matchListing(db: D1Database, l: StoredListing, now: string): Promise<{ outcome: Outcome; productId: number | null; score: number | null }> {
  const p = parseListing(l.name, l.brand, l.image)
  const mark = (status: Outcome, productId: number | null, score: number | null) =>
    db
      .prepare(`UPDATE listings SET product_id = ?, match_status = ?, match_score = ?, fingerprint = ?, matched_at = ? WHERE item_id = ?`)
      .bind(productId, status, score, p.fingerprint, now, l.item_id)
  // A person's decisions stand: on this listing, and on listings with the same telling fingerprint.
  const decided = (
    await db
      .prepare(
        `SELECT r.product_id AS id, r.status, r.item_id = ?1 AS own FROM match_reviews r JOIN listings l ON l.item_id = r.item_id
          WHERE r.status IN ('approved', 'rejected') AND (r.item_id = ?1 OR (?2 = 1 AND l.fingerprint = ?3))`,
      )
      .bind(l.item_id, telling(p.fingerprint) ? 1 : 0, p.fingerprint)
      .all<{ id: number; status: string; own: number }>()
  ).results
  const rejected = new Set(decided.filter((d) => d.status === 'rejected').map((d) => d.id))
  const twin = decided.find((d) => d.status === 'approved' && !d.own && !rejected.has(d.id))
  if (twin) {
    // A person matched a listing with this very title: the same product.
    await db.batch([mark('manual', twin.id, null), db.prepare(`UPDATE products SET updated_at = ? WHERE id = ?`).bind(now, twin.id)])
    return { outcome: 'manual', productId: twin.id, score: null }
  }
  // The rules shortlist (a hard conflict, or too little in common, rules a
  // product out); the model (pairModel.ts) says how likely each one left is
  // this product. Its score decides: linked, a person decides, or a new product.
  const shortlist = (await candidates(db, p, l.item_id))
    .filter((c) => !rejected.has(c.row.id))
    .map((c) => ({ ...c, parsed: parseListing(c.row.name, c.row.brand, c.row.image) }))
    .map((c) => ({ ...c, ...confidence(p, c.parsed, c.samePhoto) }))
    .filter((c) => levelOf(c.score) !== 'none')
  const sides = await sidesOf(db, l.item_id, shortlist.map((c) => c.row.id))
  const me: PairSide = { name: l.name, parsed: p, price: sides.own, site: l.site }
  const scored = shortlist
    .map((c) => {
      const other = sides.products.get(c.row.id)
      const score = Math.round(sameProbability(me, { name: c.row.name, parsed: c.parsed, price: other?.price ?? null, site: other?.site ?? '?' }, c.samePhoto) * 100) / 100
      return { ...c, score, reasons: [...c.reasons, `model ${Math.round(score * 100)}% sure`] }
    })
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  const level: Level = !best || best.score < MODEL.differentBelow ? 'none' : best.score >= MODEL.sameFrom ? 'high' : best.score >= 0.5 ? 'medium' : 'low'

  if (level === 'none') {
    // Existing product match? No: a new canonical product.
    const id = await createProduct(db, l, p, now)
    await mark('new', id, null).run()
    return { outcome: 'new', productId: id, score: null }
  }
  if (level === 'high') {
    // Automatic match: linked to the existing product.
    await db.batch([mark('auto', best.row.id, best.score), db.prepare(`UPDATE products SET updated_at = ?, image = COALESCE(image, ?) WHERE id = ?`).bind(now, l.image, best.row.id)])
    return { outcome: 'auto', productId: best.row.id, score: best.score }
  }
  // Medium or low: a person decides (functions/api/pp/review.ts). The listing stays unlinked meanwhile.
  await db.batch([
    db
      .prepare(`INSERT INTO match_reviews (item_id, product_id, score, level, reasons, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(l.item_id, best.row.id, best.score, level, JSON.stringify(best.reasons), now),
    mark('review', null, best.score),
  ])
  return { outcome: 'review', productId: best.row.id, score: best.score }
}

/** The newest listings not processed yet, one by one (each may create a product the next one matches). */
export async function matchNewListings(db: D1Database, now: string, limit: number): Promise<Record<Outcome, number>> {
  const done: Record<Outcome, number> = { new: 0, auto: 0, review: 0, manual: 0 }
  const { results } = await db
    .prepare(`SELECT item_id, site, name, brand, image FROM listings WHERE match_status IS NULL ORDER BY last_seen DESC LIMIT ?`)
    .bind(limit)
    .all<StoredListing>()
  for (const l of results) done[(await matchListing(db, l, now)).outcome]++
  return done
}

// ---- The links and reviews made before the model, scored again by it ----

/** Matches made before this (the rules' points) are scored again by the model; later ones already were. */
export const MODEL_SINCE = '2026-11-09T17:00:00.000Z'

interface BacklogRow {
  review_id: number | null
  item_id: string
  site: string
  name: string
  brand: string | null
  image: string | null
  match_status: string | null
  product_id: number
  p_name: string
  p_brand: string | null
  p_image: string | null
}

/**
 * A batch of the pre-model backlog through the model: pending reviews first,
 * then automatic links. A review the model is sure of is linked
 * (`model_same`) or ruled out (`model_different`, and the listing is matched
 * again); one it can't tell waits for a person, scored anew. An automatic link
 * it isn't sure of goes to review, or is matched again when it's surely
 * another product. A person's decisions are never touched.
 */
export async function rescoreBacklog(db: D1Database, now: string, limit: number): Promise<{ linked: number; different: number; review: number; kept: number; stale: number }> {
  const done = { linked: 0, different: 0, review: 0, kept: 0, stale: 0 }
  const product = `p.name AS p_name, p.brand AS p_brand, p.image AS p_image`
  const reviews = (
    await db
      .prepare(
        `SELECT r.id AS review_id, l.item_id, l.site, l.name, l.brand, l.image, l.match_status, r.product_id, ${product}
           FROM match_reviews r JOIN listings l ON l.item_id = r.item_id JOIN products p ON p.id = r.product_id
          WHERE r.status = 'pending' AND r.created_at < ? ORDER BY r.created_at LIMIT ?`,
      )
      .bind(MODEL_SINCE, limit)
      .all<BacklogRow>()
  ).results
  const autos =
    reviews.length < limit
      ? (
          await db
            .prepare(
              `SELECT NULL AS review_id, l.item_id, l.site, l.name, l.brand, l.image, l.match_status, l.product_id, ${product}
                 FROM listings l JOIN products p ON p.id = l.product_id
                WHERE l.match_status = 'auto' AND l.matched_at < ? LIMIT ?`,
            )
            .bind(MODEL_SINCE, limit - reviews.length)
            .all<BacklogRow>()
        ).results
      : []
  const rows = [...reviews, ...autos]
  if (!rows.length) return done

  // Every price the model weighs, in two reads for the whole batch.
  const last = `(SELECT price FROM price_history WHERE item_id = l.item_id ORDER BY seen_at DESC LIMIT 1)`
  const [own, founders] = await Promise.all([
    db
      .prepare(`SELECT l.item_id, ${last} AS price FROM listings l WHERE l.item_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(rows.map((r) => r.item_id)))
      .all<{ item_id: string; price: number | null }>(),
    db
      .prepare(`SELECT l.product_id AS id, l.site, ${last} AS price FROM listings l WHERE l.product_id IN (SELECT value FROM json_each(?)) AND l.match_status = 'new'`)
      .bind(JSON.stringify([...new Set(rows.map((r) => r.product_id))]))
      .all<{ id: number; site: string; price: number | null }>(),
  ])
  const priceOf = new Map(own.results.map((r) => [r.item_id, r.price]))
  const founderOf = new Map(founders.results.map((r) => [r.id, r]))

  const writes: D1Statement[] = []
  for (const r of rows) {
    if (r.review_id !== null && r.match_status !== 'review') {
      // Renamed or matched again since: this review is about a listing that has moved on.
      writes.push(db.prepare(`UPDATE match_reviews SET status = 'stale', decided_at = ? WHERE id = ?`).bind(now, r.review_id))
      done.stale++
      continue
    }
    const p = parseListing(r.name, r.brand, r.image)
    const q = parseListing(r.p_name, r.p_brand, r.p_image)
    const samePhoto = Boolean(p.photo && p.photo === q.photo)
    const founder = founderOf.get(r.product_id)
    const score =
      Math.round(
        sameProbability({ name: r.name, parsed: p, price: priceOf.get(r.item_id) ?? null, site: r.site }, { name: r.p_name, parsed: q, price: founder?.price ?? null, site: founder?.site ?? '?' }, samePhoto) *
          100,
      ) / 100
    const reasons = JSON.stringify([...confidence(p, q, samePhoto).reasons, `model ${Math.round(score * 100)}% sure`])
    const level = score >= 0.5 ? 'medium' : 'low'
    const matchAgain = db.prepare(`UPDATE listings SET product_id = NULL, match_status = NULL, match_score = NULL, matched_at = ? WHERE item_id = ?`).bind(now, r.item_id)
    if (r.review_id !== null) {
      if (score >= MODEL.sameFrom) {
        writes.push(
          db.prepare(`UPDATE match_reviews SET status = 'model_same', score = ?, reasons = ?, decided_at = ? WHERE id = ?`).bind(score, reasons, now, r.review_id),
          db.prepare(`UPDATE listings SET product_id = ?, match_status = 'auto', match_score = ?, matched_at = ? WHERE item_id = ?`).bind(r.product_id, score, now, r.item_id),
        )
        done.linked++
      } else if (score < MODEL.differentBelow) {
        writes.push(db.prepare(`UPDATE match_reviews SET status = 'model_different', score = ?, reasons = ?, decided_at = ? WHERE id = ?`).bind(score, reasons, now, r.review_id), matchAgain)
        done.different++
      } else {
        // Still for a person, with the model's score; dated now, so it isn't picked up again.
        writes.push(db.prepare(`UPDATE match_reviews SET score = ?, level = ?, reasons = ?, created_at = ? WHERE id = ?`).bind(score, level, reasons, now, r.review_id))
        done.review++
      }
    } else if (score >= MODEL.sameFrom) {
      writes.push(db.prepare(`UPDATE listings SET match_score = ?, matched_at = ? WHERE item_id = ?`).bind(score, now, r.item_id))
      done.kept++
    } else if (score < MODEL.differentBelow) {
      writes.push(matchAgain)
      done.different++
    } else {
      writes.push(
        db
          .prepare(`INSERT INTO match_reviews (item_id, product_id, score, level, reasons, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
          .bind(r.item_id, r.product_id, score, level, reasons, now),
        db.prepare(`UPDATE listings SET product_id = NULL, match_status = 'review', match_score = ?, matched_at = ? WHERE item_id = ?`).bind(score, now, r.item_id),
      )
      done.review++
    }
  }
  await db.batch(writes)
  return done
}

// ---- In search: the catalogue's products for a typed name ----

export interface CatalogOffer {
  itemId: string
  site: Listing['site']
  name: string
  url: string
}

export interface CatalogProduct {
  id: number
  name: string
  score: number
  offers: CatalogOffer[] // its listings on every store, most recently seen first
}

/**
 * The search's "find relevant products": canonical products a typed product
 * name confidently is (high), read through the same stages as a listing,
 * best first, with the offers linked to each. A name that doesn't say its
 * brand names no product here ("T50 earbuds" may be any brand's), nor one
 * that leaves a choice open ("Starship milk powder": 500 g or 1 kg?).
 */
export async function findProducts(db: D1Database, query: string, limit = 2): Promise<CatalogProduct[]> {
  const q = parseListing(query, null, null)
  if (!q.brand) return []
  const scored = (await candidates(db, q, ''))
    .map((c) => ({ row: c.row, ...confidence(q, parseListing(c.row.name, c.row.brand, c.row.image), false, true) }))
    .filter((c) => levelOf(c.score) === 'high' && c.reasons.includes('same brand'))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return Promise.all(
    scored.map(async (c) => ({
      id: c.row.id,
      name: c.row.name,
      score: c.score,
      offers: (
        await db
          .prepare(`SELECT item_id AS itemId, site, name, url FROM listings WHERE product_id = ? ORDER BY last_seen DESC LIMIT 12`)
          .bind(c.row.id)
          .all<CatalogOffer>()
      ).results,
    })),
  )
}

/**
 * A person's decision on a review, and on the other pending reviews of that
 * product for listings with the same telling fingerprint (one title copied
 * by five sellers is one decision). Same product: the listings are linked.
 * Different: the pairs are remembered, and the listings go through the
 * pipeline again without that product (another candidate, or a new
 * product). Returns how many reviews it decided.
 */
export async function decideReview(db: D1Database, id: number, same: boolean, now: string): Promise<number> {
  const review = await db
    .prepare(`SELECT r.item_id, r.product_id, l.fingerprint FROM match_reviews r JOIN listings l ON l.item_id = r.item_id WHERE r.id = ? AND r.status = 'pending'`)
    .bind(id)
    .first<{ item_id: string; product_id: number; fingerprint: string | null }>()
  if (!review) return 0
  const twins =
    review.fingerprint && telling(review.fingerprint)
      ? (
          await db
            .prepare(`SELECT r.id, r.item_id FROM match_reviews r JOIN listings l ON l.item_id = r.item_id WHERE r.status = 'pending' AND r.product_id = ? AND r.id != ? AND l.fingerprint = ?`)
            .bind(review.product_id, id, review.fingerprint)
            .all<{ id: number; item_id: string }>()
        ).results
      : []
  const all = [{ id, item_id: review.item_id }, ...twins]
  await db.batch(
    all.flatMap((r) => [
      db.prepare(`UPDATE match_reviews SET status = ?, decided_at = ? WHERE id = ?`).bind(same ? 'approved' : 'rejected', now, r.id),
      same
        ? db.prepare(`UPDATE listings SET product_id = ?, match_status = 'manual', matched_at = ? WHERE item_id = ?`).bind(review.product_id, now, r.item_id)
        : db.prepare(`UPDATE listings SET product_id = NULL, match_status = NULL WHERE item_id = ?`).bind(r.item_id),
    ]),
  )
  return all.length
}
