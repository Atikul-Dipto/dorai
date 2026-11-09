/**
 * Daraz, asked as little as possible. It bot-checks Cloudflare's addresses
 * after a burst of searches (about 100 in a few minutes did it twice, for
 * about half an hour each), and then every shopper gets "Couldn't reach
 * Daraz". So:
 *
 * - the same search, or the same product page, is read from Daraz at most
 *   once in FRESH_SECONDS, whoever asks (Cloudflare's cache, per data centre);
 * - once Daraz answers with a bot check, it isn't asked anything for
 *   PAUSE_SECONDS: asking again only makes the block last longer;
 * - while it can't be reached, a search it answered in the last day is shown
 *   with how old it is (`asOf`), rather than nothing.
 *
 * The check is never got round, only waited out.
 */

import { CACHE_VERSION, readCache, writeCache } from './cache.ts'
import * as daraz from './daraz.ts'
import { sha256 } from './devices.ts'

export const FRESH_SECONDS = 30 * 60
const KEEP_SECONDS = 24 * 3600
export const PAUSE_SECONDS = 5 * 60
const PAUSE_KEY = 'https://dorai.cache/daraz/paused'

interface Kept<T> {
  value: T
  savedAt: string
}

const keyOf = async (what: string, args: unknown[]) =>
  `https://dorai.cache/daraz/v${CACHE_VERSION}/${what}/${(await sha256(JSON.stringify(args))).slice(0, 40)}`

/** True while Daraz is being left alone after a bot check. */
export const paused = async () => (await readCache<{ at: number }>(PAUSE_KEY)) !== null

/**
 * One read from Daraz, through the cache: fresh copies are used as they are,
 * an older one only when Daraz can't be reached (with when it was read).
 */
async function politely<T>(what: string, args: unknown[], read: () => Promise<T>, fresh: number, keep: number): Promise<{ value: T; asOf: string | null }> {
  const key = await keyOf(what, args)
  const kept = await readCache<Kept<T>>(key)
  const now = Date.now()
  if (kept && now - Date.parse(kept.savedAt) < fresh * 1000) return { value: kept.value, asOf: null }
  const fallBack = (error: unknown) => {
    if (kept) return { value: kept.value, asOf: kept.savedAt }
    throw error
  }
  if (await paused()) return fallBack(new daraz.DarazBusy())
  try {
    const value = await read()
    // "Nothing" isn't kept: it may be a hiccup.
    if (value !== null) await writeCache(key, { value, savedAt: new Date(now).toISOString() } satisfies Kept<T>, keep)
    return { value, asOf: null }
  } catch (error) {
    if (error instanceof daraz.DarazBusy) await writeCache(PAUSE_KEY, { at: now }, PAUSE_SECONDS)
    return fallBack(error)
  }
}

/** Daraz's search, as `daraz.search`, at most once in FRESH_SECONDS for the same words. */
export async function search(query: string, opts: Parameters<typeof daraz.search>[1] = {}): Promise<daraz.SearchResult> {
  const words = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const { value, asOf } = await politely(
    'search',
    [words, opts?.category ?? null, opts?.minPrice ?? null, opts?.maxPrice ?? null],
    () => daraz.search(query, opts),
    FRESH_SECONDS,
    KEEP_SECONDS,
  )
  return asOf ? { ...value, asOf } : value
}

/** What a shopper is told when Daraz didn't answer. `error` is what the read failed with (through a part, its message). */
export function unreachedNote(error: unknown, othersShown = true): string {
  const busy = String(error instanceof Error ? error.message : error).includes(daraz.BUSY)
  if (!busy) return "Couldn't reach Daraz just now — try again in a moment."
  return `Couldn't reach Daraz just now: it's asking for a bot check, so DorAI gives it a few minutes.${othersShown ? ' The other shops are below.' : ' Try again shortly.'}`
}

/** ...and when what's shown is what Daraz answered earlier. Starts like the note above, so the answer isn't cached or called a hot deal. */
export function olderNote(asOf: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(asOf)) / 60_000))
  const ago = minutes < 90 ? `${minutes} minute${minutes > 1 ? 's' : ''}` : `${Math.round(minutes / 60)} hours`
  return `Couldn't reach Daraz just now, so these are its prices from ${ago} ago. Check them on Daraz before buying.`
}

// A product page: its category and title don't change, so are kept a day; its price is read fresh, and never shown old.
export const productCategory = async (url: string) => (await politely('category', [url], () => daraz.productCategory(url), KEEP_SECONDS, KEEP_SECONDS)).value
export const productTitle = async (url: string) => (await politely('title', [url], () => daraz.productTitle(url), KEEP_SECONDS, KEEP_SECONDS)).value
export const fetchProduct = async (url: string, itemId: string) =>
  (await politely('product', [url, itemId], () => daraz.fetchProduct(url, itemId), FRESH_SECONDS, FRESH_SECONDS)).value
