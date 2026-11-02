/**
 * The search & price cache, in Cloudflare's Cache API (free, per data
 * centre): a comparison is kept 6 hours (compare.ts), the same search 15
 * minutes (functions/api/pp/ask.ts). Repeat questions then cost the stores
 * nothing. An answer where a store couldn't be reached is never kept.
 */

// Raised whenever matching changes, so cached answers from the old rules are dropped.
export const CACHE_VERSION = 12

const cacheStore = () => (globalThis as { caches?: { default?: Cache } }).caches?.default

export async function readCache<T>(key: string): Promise<T | null> {
  const hit = await cacheStore()?.match(key).catch(() => undefined)
  return hit ? ((await hit.json()) as T) : null
}

export async function writeCache(key: string, value: unknown, seconds: number): Promise<void> {
  await cacheStore()
    ?.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${seconds}` } }))
    .catch(() => undefined)
}

/** A cache key for a search: the same words, however spaced or capitalised, are the same search. */
export async function searchKey(parts: (string | undefined)[]): Promise<string> {
  const text = parts.map((p) => (p ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).join('|')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `https://dorai.cache/ask/v${CACHE_VERSION}/${hex}`
}
