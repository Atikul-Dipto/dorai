/**
 * Visitor profiles: what one shopper searches and looks up, for the owner's
 * page (/profiles). Only for a shopper who said yes on the site; nobody else's
 * rows are linked to anything, and the extension never sends an id.
 *
 * The browser keeps a random id and the database a salted hash of it, so
 * nothing in the database can be used to act as that visitor. No name, address
 * or account. A shopper can delete theirs at any time, and the link is dropped
 * after a year.
 */

import { sha256 } from './devices.ts'
import type { D1Database, Env } from './types.ts'

export const KEEP_DAYS = 365
const VISITORS = 100
const ROWS = 500
const TIMELINE = 100
const BANGLADESH_HOURS = 6

/** The stored key for a browser's id, or null for anything that isn't one. */
export async function visitorKey(env: Env, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !/^[a-f0-9]{32}$/.test(raw)) return null
  return (await sha256(`${env.RATE_SALT ?? 'dorai'}|visitor|${raw}`)).slice(0, 32)
}

export interface AskRow {
  at: string
  query: string
  mode: string | null
  results: number
}

export interface EventRow {
  at: string
  kind: string
  query: string
  itemId: string
  site: string
  price: number | null
  name: string | null
  url: string | null
  brand: string | null
}

function tally(values: string[]) {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n)
}

function partOfDay(at: string) {
  const hour = (new Date(at).getUTCHours() + BANGLADESH_HOURS) % 24
  if (hour < 5 || hour >= 22) return 'night'
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'
}

const sameSearch = (query: string) => query.trim().toLowerCase()

/** The pattern in one visitor's rows, newest first as read. */
export function patternOf(asks: AskRow[], events: EventRow[]) {
  const opens = events.filter((e) => e.kind === 'open')
  const interest = events.filter((e) => e.kind === 'open' || e.kind === 'save')
  const searches = new Set(asks.map((a) => sameSearch(a.query)))
  const opened = new Set(opens.map((e) => sameSearch(e.query)))
  const prices = opens.flatMap((e) => e.price ?? []).sort((a, b) => a - b)

  const products = new Map<string, { itemId: string; site: string; name: string | null; url: string | null; price: number | null; opens: number; saves: number }>()
  for (const e of interest) {
    const p = products.get(e.itemId) ?? { itemId: e.itemId, site: e.site, name: e.name, url: e.url, price: e.price, opens: 0, saves: 0 }
    if (e.kind === 'open') p.opens++
    else p.saves++
    products.set(e.itemId, p)
  }

  return {
    searches: asks.length,
    differentSearches: searches.size,
    searchedAgain: tally(asks.map((a) => sameSearch(a.query)))
      .filter((s) => s.n > 1)
      .slice(0, 10),
    howTheySearch: tally(asks.map((a) => a.mode || 'failed')),
    // Of the different searches, how many led to opening an offer.
    openedFrom: [...searches].filter((s) => opened.has(s)).length,
    stores: tally(opens.map((e) => e.site)),
    brands: tally(interest.flatMap((e) => (e.brand && !/^no\s*brand$/i.test(e.brand) ? [e.brand] : []))).slice(0, 8),
    priceRange: prices.length ? { low: prices[0], middle: prices[prices.length >> 1], high: prices[prices.length - 1] } : null,
    partsOfDay: tally(asks.map((a) => partOfDay(a.at))),
    products: [...products.values()].sort((a, b) => b.opens + b.saves - a.opens - a.saves).slice(0, 20),
    notWanted: events.filter((e) => e.kind === 'not_this').map((e) => ({ query: e.query, site: e.site, name: e.name })),
  }
}

/** Everyone with a history, most recently active first. */
export async function listProfiles(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT visitor AS key, MIN(at) AS firstSeen, MAX(at) AS lastSeen, SUM(kind = 'search') AS searches,
              SUM(kind = 'open') AS opens, SUM(kind = 'save') AS saves, SUM(kind = 'not_this') AS notWanted
         FROM (SELECT visitor, asked_at AS at, 'search' AS kind FROM asks WHERE visitor IS NOT NULL
               UNION ALL
               SELECT visitor, at, kind FROM interactions WHERE visitor IS NOT NULL)
        GROUP BY visitor ORDER BY lastSeen DESC LIMIT ?`,
    )
    .bind(VISITORS)
    .all()
  return results
}

/** One visitor's pattern and latest acts, or null when there's no such history. */
export async function readProfile(db: D1Database, key: string) {
  const [asks, events] = await Promise.all([
    db.prepare(`SELECT asked_at AS at, query, mode, results FROM asks WHERE visitor = ? ORDER BY asked_at DESC LIMIT ?`).bind(key, ROWS).all<AskRow>(),
    db
      .prepare(
        `SELECT i.at, i.kind, i.query, i.item_id AS itemId, i.site, i.price, l.name, l.url, l.brand
           FROM interactions i LEFT JOIN listings l ON l.item_id = i.item_id
          WHERE i.visitor = ? ORDER BY i.at DESC LIMIT ?`,
      )
      .bind(key, ROWS)
      .all<EventRow>(),
  ])
  if (!asks.results.length && !events.results.length) return null
  const seen = [...asks.results, ...events.results].map((r) => r.at).sort()
  const timeline = [
    ...asks.results.map((a) => ({ at: a.at, act: 'search', query: a.query, results: a.results })),
    ...events.results.map((e) => ({ at: e.at, act: e.kind, query: e.query, site: e.site, name: e.name, price: e.price })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TIMELINE)
  return { key, firstSeen: seen[0], lastSeen: seen[seen.length - 1], pattern: patternOf(asks.results, events.results), timeline }
}

/** A shopper turning it off: their history goes, not just the link to it. */
export async function forgetProfile(db: D1Database, key: string): Promise<void> {
  await db.batch([db.prepare(`DELETE FROM asks WHERE visitor = ?`).bind(key), db.prepare(`DELETE FROM interactions WHERE visitor = ?`).bind(key)])
}

/** Past a year, rows stay in the anonymous log with the link to the visitor gone. */
export async function expireProfiles(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString()
  await db.batch([
    db.prepare(`UPDATE asks SET visitor = NULL WHERE visitor IS NOT NULL AND asked_at < ?`).bind(cutoff),
    db.prepare(`UPDATE interactions SET visitor = NULL WHERE visitor IS NOT NULL AND at < ?`).bind(cutoff),
  ])
}
