/**
 * The watchlist & alert service: each device's saved products on the
 * server, the scheduled price checks they need, and the rule for when a
 * price drop is worth telling.
 */

import { readProductUrl } from './links.ts'
import { enqueue } from './queue.ts'
import type { D1Database, Listing } from './types.ts'

export const MAX_WATCHES = 50
// How often a watched product's price is checked again.
export const CHECK_EVERY_HOURS = 6
// Without a target price, a drop is told when it's at least this much below the price when saved.
const DROP_RATIO = 0.05

export interface Watch {
  device_id: string
  item_id: string
  site: Listing['site']
  name: string
  url: string
  image: string
  saved_price: number
  target_price: number | null
  last_price: number | null
  last_checked: string | null
  alerted_price: number | null
}

export interface WatchInput {
  itemId: string
  site: Listing['site']
  name: string
  url: string
  image?: string
  savedPrice: number
  targetPrice?: number | null
}

/** A watch as sent by a page: a real store product address, a price, a name. Null if it isn't one. */
export function readWatch(raw: unknown): WatchInput | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const ref = typeof w.url === 'string' ? readProductUrl(w.url) : null
  const price = Number(w.savedPrice)
  const target = w.targetPrice == null || w.targetPrice === '' ? null : Number(w.targetPrice)
  if (!ref || ref.site !== w.site || typeof w.itemId !== 'string' || !w.itemId || w.itemId.length > 80) return null
  if (!Number.isFinite(price) || price <= 0 || (target !== null && (!Number.isFinite(target) || target <= 0))) return null
  return {
    itemId: w.itemId,
    site: ref.site,
    name: String(w.name ?? '').slice(0, 200) || ref.slug,
    url: ref.url,
    image: typeof w.image === 'string' && /^https:\/\//.test(w.image) ? w.image.slice(0, 500) : '',
    savedPrice: price,
    targetPrice: target,
  }
}

export async function listWatches(db: D1Database, deviceId: string): Promise<Watch[]> {
  const { results } = await db.prepare(`SELECT * FROM watches WHERE device_id = ? ORDER BY created_at DESC`).bind(deviceId).all<Watch>()
  return results
}

/** Adds or updates a device's watches; false when it would go past MAX_WATCHES. */
export async function putWatches(db: D1Database, deviceId: string, watches: WatchInput[], now: string): Promise<boolean> {
  const have = await db.prepare(`SELECT item_id FROM watches WHERE device_id = ?`).bind(deviceId).all<{ item_id: string }>()
  const known = new Set(have.results.map((r) => r.item_id))
  if (known.size + watches.filter((w) => !known.has(w.itemId)).length > MAX_WATCHES) return false
  if (!watches.length) return true
  await db.batch(
    watches.map((w) =>
      db
        .prepare(
          `INSERT INTO watches (device_id, item_id, site, name, url, image, saved_price, target_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(device_id, item_id) DO UPDATE SET target_price = excluded.target_price, name = excluded.name, image = excluded.image`,
        )
        .bind(deviceId, w.itemId, w.site, w.name, w.url, w.image ?? '', w.savedPrice, w.targetPrice ?? null, now),
    ),
  )
  // A newly watched product gets its first check soon.
  for (const w of watches.filter((x) => !known.has(x.itemId))) await enqueue(db, 'check_price', w.itemId, { itemId: w.itemId, site: w.site, url: w.url, name: w.name }, now)
  return true
}

export async function removeWatch(db: D1Database, deviceId: string, itemId: string): Promise<void> {
  await db.prepare(`DELETE FROM watches WHERE device_id = ? AND item_id = ?`).bind(deviceId, itemId).run()
}

/** One check_price task per watched product not checked in CHECK_EVERY_HOURS. */
export async function enqueueDueChecks(db: D1Database, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - CHECK_EVERY_HOURS * 3600_000).toISOString()
  await db
    .prepare(
      `INSERT OR IGNORE INTO tasks (kind, key, payload, run_after, created_at, updated_at)
       SELECT 'check_price', item_id, json_object('itemId', item_id, 'site', MAX(site), 'url', MAX(url), 'name', MAX(name)), ?1, ?1, ?1
         FROM watches GROUP BY item_id HAVING MAX(COALESCE(last_checked, '')) < ?2`,
    )
    .bind(now, cutoff)
    .run()
}

/**
 * Whether a watched product's new price is worth an alert: at or below the
 * shopper's target when they set one; otherwise at least 5% below the price
 * when saved. Each drop is told once: a new alert needs a lower price than
 * the last one was about.
 */
export function dropWorthTelling(w: Pick<Watch, 'saved_price' | 'target_price' | 'alerted_price'>, price: number): boolean {
  if (w.alerted_price !== null && price >= w.alerted_price) return false
  if (w.target_price !== null) return price <= w.target_price
  return price <= w.saved_price * (1 - DROP_RATIO)
}

/** The checked price written to every watch of the product; returns the watches to alert. */
export async function recordCheck(db: D1Database, itemId: string, price: number | null, now: string): Promise<Watch[]> {
  await db.prepare(`UPDATE watches SET last_checked = ?, last_price = COALESCE(?, last_price) WHERE item_id = ?`).bind(now, price, itemId).run()
  if (price === null) return []
  const { results } = await db.prepare(`SELECT * FROM watches WHERE item_id = ?`).bind(itemId).all<Watch>()
  return results.filter((w) => dropWorthTelling(w, price))
}
