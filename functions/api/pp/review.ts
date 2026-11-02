/**
 * /api/pp/review — the product matching engine's manual review
 * (worker/catalog.ts), for the owner only: "Authorization: Bearer <ADMIN_TOKEN>".
 * The page is /review (public/review.html).
 *
 *   GET                                  the catalogue's counts and the oldest pending reviews
 *   POST { id, decision: "same" | "different" }   decide one
 */

import { decideReview } from '../../../worker/catalog.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { D1Database, Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env & { ADMIN_TOKEN?: string } }

const PAGE = 20

const admin = ({ request, env }: Ctx) => Boolean(env.ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`

// A listing with its latest price, as the review page shows it.
const OFFER = `l.item_id AS itemId, l.site, l.name, l.url, l.image, l.brand,
  (SELECT price FROM price_history ph WHERE ph.item_id = l.item_id ORDER BY seen_at DESC LIMIT 1) AS price`

async function pending(db: D1Database) {
  const { results: reviews } = await db
    .prepare(
      `SELECT r.id, r.score, r.level, r.reasons, r.created_at AS createdAt, r.product_id AS productId, ${OFFER}
         FROM match_reviews r JOIN listings l ON l.item_id = r.item_id
        WHERE r.status = 'pending' ORDER BY r.created_at LIMIT ?`,
    )
    .bind(PAGE)
    .all<{ id: number; productId: number; reasons: string }>()
  return Promise.all(
    reviews.map(async (r) => {
      const product = await db.prepare(`SELECT id, name, brand, model, image FROM products WHERE id = ?`).bind(r.productId).first<Record<string, unknown>>()
      const { results: offers } = await db.prepare(`SELECT ${OFFER} FROM listings l WHERE l.product_id = ? LIMIT 6`).bind(r.productId).all()
      return { ...r, reasons: JSON.parse(r.reasons), product: { ...product, offers } }
    }),
  )
}

export const onRequestGet = async (ctx: Ctx) => {
  const db = ctx.env.PP_DB
  if (!db) return json(ctx.request, { error: 'Not configured.' }, 503)
  if (!admin(ctx)) return json(ctx.request, { error: 'Not allowed.' }, 403)
  const { results: counts } = await db.prepare(`SELECT COALESCE(match_status, 'waiting') AS status, COUNT(*) AS n FROM listings GROUP BY 1`).all<{ status: string; n: number }>()
  const products = await db.prepare(`SELECT COUNT(*) AS n, SUM(offers > 1) AS shared FROM (SELECT p.id, COUNT(l.item_id) AS offers FROM products p LEFT JOIN listings l ON l.product_id = p.id GROUP BY p.id)`).first<{ n: number; shared: number }>()
  return json(ctx.request, { listings: Object.fromEntries(counts.map((c) => [c.status, c.n])), products, reviews: await pending(db) })
}

export const onRequestPost = async (ctx: Ctx) => {
  const db = ctx.env.PP_DB
  if (!db) return json(ctx.request, { error: 'Not configured.' }, 503)
  if (!admin(ctx)) return json(ctx.request, { error: 'Not allowed.' }, 403)
  const body = (await ctx.request.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null
  if (typeof body?.id !== 'number' || (body.decision !== 'same' && body.decision !== 'different')) return json(ctx.request, { error: 'Send { id, decision: "same" | "different" }.' }, 400)
  // `decided` counts this review and the same-title ones it settled with it.
  const decided = await decideReview(db, body.id, body.decision === 'same', new Date().toISOString())
  return decided ? json(ctx.request, { decided }) : json(ctx.request, { error: 'That review is already decided, or there is no such review.' }, 404)
}

export const onRequestOptions = preflight
