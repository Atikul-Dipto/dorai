/**
 * Learning events: what shoppers do with an answer — open an offer at its
 * store, save it, take it off the watchlist, or say it's not what they
 * wanted. Recorded so the agent can learn which picks people actually want
 * (docs/ARCHITECTURE.md, "Learning events"); nothing in ranking uses them
 * yet. No visitor information is kept: the search, the offer, the act, when.
 */

import type { RowRelation } from './matching.ts'
import type { D1Database, Listing } from './types.ts'

export const KINDS = ['open', 'save', 'unsave', 'not_this'] as const
export type Kind = (typeof KINDS)[number]
const SITES: Listing['site'][] = ['daraz', 'cartup', 'othoba']
const RELATIONS = new Set<string>(['same', 'variant', 'close', 'fits'] satisfies RowRelation[])
export const MAX_EVENTS = 10

export interface Interaction {
  kind: Kind
  query: string
  itemId: string
  site: Listing['site']
  slot: 'pick' | 'match'
  relation: string | null
  position: number
  price: number | null
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** One event from a request, or null when it isn't one. */
export function readInteraction(raw: unknown): Interaction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = KINDS.find((k) => k === r.kind)
  const site = SITES.find((s) => s === r.site)
  const query = text(r.query, 200)
  const itemId = text(r.itemId, 80)
  if (!kind || !site || query.length < 2 || !/^[\w:.-]+$/.test(itemId)) return null
  const slot = r.slot === 'match' ? 'match' : 'pick'
  const relation = typeof r.relation === 'string' && RELATIONS.has(r.relation) ? r.relation : null
  const position = Number.isInteger(r.position) && (r.position as number) >= 0 && (r.position as number) < 50 ? (r.position as number) : 0
  const price = typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0 ? r.price : null
  return { kind, query, itemId, site, slot, relation: slot === 'match' ? relation : null, position: slot === 'pick' ? 0 : position, price }
}

/** Records them, each with the canonical product its offer is linked to now. */
export async function recordInteractions(db: D1Database, events: Interaction[], now: string): Promise<void> {
  if (!events.length) return
  await db.batch(
    events.map((e) =>
      db
        .prepare(
          `INSERT INTO interactions (at, kind, query, item_id, site, slot, relation, position, price, product_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT product_id FROM listings WHERE item_id = ?))`,
        )
        .bind(now, e.kind, e.query, e.itemId, e.site, e.slot, e.relation, e.position, e.price, e.itemId),
    ),
  )
}

/**
 * The owner's readout since a time: how many of each act; whether people
 * open the stores' picks or rows further down (and which kinds of row); the
 * offers opened most; and the picks most often called not what was wanted.
 */
export async function summarizeInteractions(db: D1Database, since: string) {
  const [kinds, opened, slots, notThis] = await Promise.all([
    db.prepare(`SELECT kind, COUNT(*) AS n FROM interactions WHERE at >= ? GROUP BY kind`).bind(since).all<{ kind: string; n: number }>(),
    db
      .prepare(
        `SELECT i.item_id AS itemId, i.site, l.name, COUNT(*) AS n FROM interactions i LEFT JOIN listings l ON l.item_id = i.item_id
          WHERE i.at >= ? AND i.kind = 'open' GROUP BY i.item_id ORDER BY n DESC LIMIT 10`,
      )
      .bind(since)
      .all(),
    db
      .prepare(`SELECT slot, COALESCE(relation, '') AS relation, COUNT(*) AS n FROM interactions WHERE at >= ? AND kind = 'open' GROUP BY slot, relation ORDER BY n DESC`)
      .bind(since)
      .all(),
    db
      .prepare(
        `SELECT i.query, i.item_id AS itemId, i.site, l.name, COUNT(*) AS n FROM interactions i LEFT JOIN listings l ON l.item_id = i.item_id
          WHERE i.at >= ? AND i.kind = 'not_this' GROUP BY i.query, i.item_id ORDER BY n DESC LIMIT 20`,
      )
      .bind(since)
      .all(),
  ])
  return {
    since,
    counts: Object.fromEntries(kinds.results.map((k) => [k.kind, k.n])),
    openedBySlot: slots.results,
    mostOpened: opened.results,
    notWanted: notThis.results,
  }
}
