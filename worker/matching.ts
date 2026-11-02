/**
 * The product matching engine: which listings are the same product, another
 * size or variant of it, or a close match — across stores whose titles are
 * written differently. Used by the search orchestrator (agent.ts) and the
 * compare service (compare.ts).
 */

import { compact, foundWords, isAccessory, isBundle, mainModel, modelTokens, namesAllOf, quantities, sizesAgree, storageOf, tokens, variantsOf, withoutVariants } from './ranking.ts'
import type { Intent, Listing } from './types.ts'

export const STOP = new Set(['for', 'with', 'and', 'the', 'of', 'new', 'original', 'pcs', 'pc', 'official', 'warranty'])
export const words = (s: string) => tokens(s).filter((t) => !STOP.has(t))
// Words sellers add to any title; they never make it a different product.
export const SALES_TALK = new Set(['premium', 'quality', 'high', 'best', 'special', 'genuine', 'authentic', 'imported', 'fresh', 'super', 'top', 'hot', 'sale', 'care'])
export const COLOURS = new Set(['black', 'white', 'red', 'blue', 'green', 'pink', 'grey', 'gray', 'silver', 'gold', 'purple', 'yellow', 'orange', 'brown', 'graphite'])

export type Relation = 'same' | 'variant' | 'close'

/**
 * How listings relate to the product `title` (the shopper's product name, or
 * a store's pick):
 *   same    — the product itself. Across stores, titles are written
 *             differently — Daraz's "Dahua LM27-B221B=V1 27 Inch Full HD..."
 *             is Cartup's "Dahua LM27-B221B 27 Inch IPS Monitor" — so instead
 *             of every code in the title, the main (longest) model code must
 *             match, with the same variant words (Pro/Plus/...), the same
 *             storage and size where both state one, and heavy word overlap.
 *   variant — the same product in another size, storage or variant
 *             ("Pran Miniket Rice 25kg" for "miniket rice 5kg").
 *   close   — most of its words, or a short name made of them ("Jordan Chest
 *             Bag" for the Air Jordan crossbody chest/waist bag).
 * Null for anything less. Out-of-stock listings and accessories never relate.
 *
 * With `ref`, the listing the title belongs to, its photo counts too (see
 * `photoId`): the same photo file is the same product whatever the titles
 * say, and an unbranded product with no model code isn't "the same" on a
 * near-identical title alone.
 */
export function relations(title: string, ref?: Listing | null): (l: Listing) => Relation | null {
  const main = mainModel(title)
  const [variants, storage, size] = [variantsOf(title, main), storageOf(title), quantities(title)]
  const titleTokens = tokens(title)
  // Which product line, whatever the size or variant: the identity words.
  const line = withoutVariants(title)
  const lineWords = [...new Set(words(line))]
  // A two-character code names nothing alone: "3S" is the MX Master 3S and
  // the MX Anywhere 3S, so the word before it ("master") must be there too —
  // unless it's the title's first word (the brand, often left out).
  const at = main && main.length <= 2 ? titleTokens.indexOf(main) : -1
  const lead = at > 1 && /^[a-z]+$/.test(titleTokens[at - 1]) ? titleTokens[at - 1] : null
  // With a model code, a close match is a sibling model: the same letters and
  // a nearby number — the KL68 for the KL69, the A26 or A37 for the A36, the
  // WH-1000XM4 for the XM5 — not the WF-1000XM5 earbuds or a Galaxy A07.
  // ("3S" is too short to have a family; the words decide there.)
  const shape = (code: string) => code.replace(/\d+/g, '#')
  const number = (code: string) => Number(code.replace(/\D/g, ''))
  const sibling = (name: string) =>
    !main ||
    main.length < 3 ||
    compact(name).includes(main) ||
    modelTokens(tokens(name)).some((c) => shape(c) === shape(main) && Math.abs(number(c) - number(main)) <= 0.3 * number(main))
  const bundle = isBundle(title)
  // Words a name adds between the title's own words name another product in
  // the same line: "Parachute Just for Baby – Milky Glow Lotion" isn't its
  // "Baby Lotion". A brand or description before or after them doesn't
  // ("Pran Miniket Rice", "Khan Rice Miniket premium Packet"), nor does sales talk.
  const lineOrder = words(line)
  // What kind of thing it is: the title's last plain word ("lotion", "bag",
  // "keyboard"), colours aside. A brand + model title ("MX Master 3S") has none.
  const tail = lineOrder.filter((w) => !COLOURS.has(w)).at(-1)
  const noun = tail && /^[a-z]+$/.test(tail) ? tail : null
  const joined = new Set(lineOrder.slice(1).map((w, i) => lineOrder[i] + w))
  const inserted = (nameLine: string) => {
    const ws = words(nameLine)
    const hit = ws.map((w) => joined.has(w) || foundWords([w], line).length > 0)
    const [first, last] = [hit.indexOf(true), hit.lastIndexOf(true)]
    return ws.some((w, i) => i > first && i < last && !hit[i] && !SALES_TALK.has(w))
  }
  const relate = (name: string, earlier = false, brand = ''): Relation | null => {
    // A combo or gift box isn't the product in it, or another size of it.
    if (isBundle(name) && !bundle) return null
    // Shares of each name's line words found in the other.
    const nameLine = withoutVariants(name)
    const nl = [...new Set(words(nameLine))]
    const ofTitle = foundWords(lineWords, nameLine).length / (lineWords.length || 1)
    const ofName = foundWords(nl, line).length / (nl.length || 1)
    // A close match keeps the make — the name's first or second word ("Air
    // Jordan", "Jedel KL69", "miniket rice") — not just its generic words
    // (a women's "waterproof crossbody chest waist bag" isn't an Air Jordan one).
    const sameMake = foundWords(lineWords.slice(0, 2), nameLine).length > 0
    // ...and is the same kind of thing: a Baby Shampoo isn't close to a Baby Lotion.
    const sameKind = !noun || foundWords([noun], nameLine).length > 0
    const close = sameMake && sameKind && sibling(name) && (ofTitle >= 0.6 || (ofTitle >= 0.4 && ofName >= 0.75)) ? 'close' : null
    if (main && !(compact(name).includes(main) && namesAllOf(name, title))) return close
    if (lead && !foundWords([lead], name).length) return close
    // With a model code in common, most words is enough. Without one, the
    // words are the identity: the name holds (nearly) all of the title's
    // ("Khan Rice Miniket premium 2 KG Packet" is miniket rice; "Teer
    // Nazirshail Rice 5kg" isn't), or is held in it and covers at least half
    // of it ("Jordan Chest Bag" doesn't). A renamed listing's earlier name
    // has to hold it all: a generic old "Kodomo Baby Lotion Powder 180ml"
    // doesn't make today's "(Extra Mild)" the Pink Hanabaki one. Either way
    // the name needs the title's first word, usually the brand: a plain
    // "Mustard Oil 1 liter" isn't Radhuni's, and "Farmland Full Cream Milk
    // Powder 1kg" (5 of 6 words) isn't Starship's. Stores that keep the
    // brand apart from the name (Cartup) have it in the brand field.
    const hasFirst = !lineWords.length || foundWords(lineWords.slice(0, 1), `${brand} ${nameLine}`).length > 0
    const identity = main ? Math.max(ofTitle, ofName) >= 0.6 : hasFirst && (ofTitle >= 0.8 || (!earlier && ofName >= 0.8 && ofTitle >= 0.5))
    if (!identity) return close
    const s = storageOf(name)
    const differs =
      variantsOf(name, main) !== variants ||
      (!main && inserted(nameLine)) ||
      (storage !== null && s !== null && s !== storage) ||
      (size.size > 0 && quantities(name).size > 0 && !sizesAgree(size, name))
    return differs ? 'variant' : 'same'
  }
  const order: (Relation | null)[] = ['same', 'variant', 'close', null]
  const photo = ref ? photoId(ref) : null
  // "Fashion Sports Led Watch... for Men" and "...for Students" are two
  // different No Brand watches: for these, a look-alike title is no identity.
  const titleProves = !ref || Boolean(main) || !UNBRANDED.test(ref.brand.trim())
  // A copied listing is, though: "Prestige Electric Kettle - 2L - Silver and
  // Black - Elevate Your Tea-Making Experience", word for word on Daraz and
  // Cartup (both "No Brand", each with its own photo upload). Long enough
  // to be specific, identical once case and punctuation are set aside.
  const wording = titleTokens.length >= 5 ? titleTokens.join(' ') : null
  const sameWording = (l: Listing) => wording !== null && [l.name, l.alsoNamed].some((n) => n && tokens(n).join(' ') === wording)
  return (l) => {
    if (!l.inStock || isAccessory(l, titleTokens)) return null
    // A renamed Cartup listing is what it is under either of its names.
    const found = [relate(l.name, false, l.brand), l.alsoNamed ? relate(l.alsoNamed, true, l.brand) : null]
    const byTitle = found.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]
    if (!photo || l.itemId === ref?.itemId) return byTitle
    // The same photo file: Cartup's "Squares Led Digital Sports Watch" is
    // Daraz's "Fashion Sports Led Watch", uploaded with Daraz's own photo.
    if (photoId(l) === photo) return isBundle(l.name) && !bundle ? null : size.size && quantities(l.name).size && !sizesAgree(size, l.name) ? 'variant' : 'same'
    return byTitle === 'same' && !titleProves && !sameWording(l) ? 'close' : byTitle
  }
}

// What stores write as the brand of something without one.
export const UNBRANDED = /^(no ?brand|generic|oem|unbranded|n\/a)$/i

/**
 * The photo's file id: Daraz names images by a 32-character hash
 * ("/p/2c6060c50c1952d4884713f4be91002b.jpg"), and sellers who copy a
 * listing to Cartup upload the same file ("/product/2c6060c5...-1743053179278.webp").
 */
export const photoFile = (image: string | null | undefined): string | null => /\/([0-9a-f]{32})(?=[-._])/i.exec(image ?? '')?.[1]?.toLowerCase() ?? null
export const photoId = (l: Listing): string | null => photoFile(l.image)

/** The listings that are the same product as `title`. */
export function sameProduct(listings: Listing[], title: string, ref?: Listing | null): Listing[] {
  const relate = relations(title, ref)
  return listings.filter((l) => relate(l) === 'same')
}

/** Share of `title`'s words a listing has, under its best name. */
function closeness(l: Listing, title: string): number {
  const t = [...new Set(words(title))]
  return Math.max(...[l.name, l.alsoNamed].map((name) => (name ? foundWords(t, name).length / (t.length || 1) : 0)))
}

/** How a "More" row matches the product: the product itself, another size, a close match, or another fit for a need. */
export type RowRelation = 'same' | 'variant' | 'close' | 'fits'

export interface Row {
  listing: Listing
  relation: RowRelation
  label: string
  otherStore?: boolean // the other store's pick, carried here too
}

/**
 * A store's "More" list, every row matched to the product, best match first.
 * Named product: its other sellers (`same`, already vetted), then other sizes
 * or variants of it, then close matches. Kind of item: other sellers and
 * sizes of the store's pick, the other store's pick if this store has it too,
 * then the next best fits (`fits`). Nothing unrelated is added to fill it out.
 * `ref` is the price the rows are held against: a "match" at a third of it is
 * a part or a copy.
 */
export function matchRows(o: {
  intent: Intent
  title: string
  ref: Listing | null
  same: Listing[]
  pool: Listing[]
  otherPick?: { label: string; listing: Listing } | null
  fits?: Listing[]
}): Row[] {
  const named = o.intent.mode === 'product'
  const rows: Row[] = []
  const taken = new Set<string>()
  const add = (listing: Listing, relation: Row['relation'], label: string, otherStore = false) => {
    if (taken.has(listing.itemId)) return
    taken.add(listing.itemId)
    rows.push({ listing, relation, label, ...(otherStore && { otherStore }) })
  }
  const inBudget = (l: Listing) => (o.intent.maxPrice === null || l.price <= o.intent.maxPrice) && (o.intent.minPrice === null || l.price >= o.intent.minPrice)
  const floor = (o.ref?.price ?? 0) * 0.3
  const sameLabel = named ? 'Same product' : 'Same product, another seller'
  for (const l of o.same) add(l, 'same', sameLabel)

  const relate = o.title ? relations(o.title, o.ref) : () => null
  const pool = o.pool.filter((l) => !taken.has(l.itemId) && l.price >= floor).map((l) => ({ l, r: relate(l) }))
  const cheapest = (r: Relation) => pool.filter((x) => x.r === r).map((x) => x.l).sort((a, b) => a.price - b.price)
  if (!named) {
    // A kind of item: rank vetted only the pick, so other sellers are held to its price.
    for (const l of cheapest('same')) if (inBudget(l) && l.price >= (o.ref?.price ?? 0) * 0.6) add(l, 'same', sameLabel)
    if (o.otherPick) for (const l of sameProduct(o.pool, o.otherPick.listing.name, o.otherPick.listing)) if (inBudget(l)) add(l, 'same', `Same as ${o.otherPick.label}'s pick`, true)
  }
  // Another size of a named product is shown whatever the budget; for a kind of item, within it.
  for (const l of cheapest('variant')) if (named || inBudget(l)) add(l, 'variant', 'Other size or variant')
  if (named) {
    const close = cheapest('close').sort((a, b) => closeness(b, o.title) - closeness(a, o.title))
    for (const l of close) if (inBudget(l)) add(l, 'close', 'Close match')
  }
  // Other fits are single products too, unless a bundle was asked for.
  const bundles = isBundle(o.intent.searchQuery)
  for (const l of o.fits ?? []) if (l.price >= floor && (bundles || !isBundle(l.name))) add(l, 'fits', 'Also fits')
  return rows
}

/**
 * For a kind of item, the stores' cards show the same product when one
 * store's pick is sold on the other too, so the prices compare like for like:
 * "lotion" had Daraz's Parachute Baby Lotion 100ml beside a ৳1,499 newborn
 * lotion on Cartup, which sold the Parachute one too, at ৳198. Of two picks
 * both stores sell, the one more buyers have reviewed (in both stores); if
 * neither store sells the other's pick, each keeps its own (null).
 */
export function sharedPick(a: { pick: Listing; elsewhere: Listing[] }, b: { pick: Listing; elsewhere: Listing[] }): 'a' | 'b' | null {
  const reviewed = (x: { pick: Listing; elsewhere: Listing[] }) => [x.pick, ...x.elsewhere].reduce((n, l) => n + l.reviews, 0)
  if (a.elsewhere.length && b.elsewhere.length) return reviewed(b) > reviewed(a) ? 'b' : 'a'
  return a.elsewhere.length ? 'a' : b.elsewhere.length ? 'b' : null
}

/** Two stores' listings of one product, judged from either title (one store's may say more). */
export const samePicks = (a: Listing, b: Listing) => sameProduct([b], a.name, a).length > 0 || sameProduct([a], b.name, b).length > 0
