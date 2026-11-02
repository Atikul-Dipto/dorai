/**
 * /api/pp/watchlist — a device's saved products on the server, so price
 * checks and alerts can run while the page is closed (worker/watchlist.ts).
 * All calls need "Authorization: Bearer <token>" from /api/pp/device.
 *
 *   GET                                  the device's watches
 *   PUT  { watches: [{ itemId, site, name, url, image?, savedPrice, targetPrice? }] }   add or update
 *   DELETE ?itemId=...                   stop watching one product
 */

import { allow, authDevice } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { Env } from '../../../worker/types.ts'
import { listWatches, MAX_WATCHES, putWatches, readWatch, removeWatch } from '../../../worker/watchlist.ts'

type Ctx = { request: Request; env: Env }

const CHANGES_PER_HOUR = 200

async function deviceOf({ request, env }: Ctx) {
  if (!env.PP_DB) return { error: json(request, { error: 'Not configured.' }, 503) }
  const device = await authDevice(env.PP_DB, request)
  return device ? { db: env.PP_DB, device } : { error: json(request, { error: 'Unknown device.' }, 401) }
}

export const onRequestGet = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  return json(ctx.request, { watches: await listWatches(r.db, r.device.id) })
}

export const onRequestPut = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  if (!(await allow(r.db, `watch:${r.device.id}`, CHANGES_PER_HOUR, 3600, new Date()))) return json(ctx.request, { error: 'Too many changes. Try again later.' }, 429)
  const body = (await ctx.request.json().catch(() => null)) as { watches?: unknown[] } | null
  const raw = Array.isArray(body?.watches) ? body.watches.slice(0, MAX_WATCHES) : []
  const watches = raw.map(readWatch).filter((w) => w !== null)
  if (watches.length !== raw.length) return json(ctx.request, { error: 'A watch needs a Daraz, Cartup or Othoba product address, its item id and a price.' }, 400)
  if (!(await putWatches(r.db, r.device.id, watches, new Date().toISOString()))) return json(ctx.request, { error: `A watchlist holds up to ${MAX_WATCHES} products.` }, 409)
  return json(ctx.request, { watches: await listWatches(r.db, r.device.id) })
}

export const onRequestDelete = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  const itemId = new URL(ctx.request.url).searchParams.get('itemId') ?? ''
  if (!itemId) return json(ctx.request, { error: 'Which product? Give ?itemId=.' }, 400)
  await removeWatch(r.db, r.device.id, itemId)
  return json(ctx.request, { removed: itemId })
}

export const onRequestOptions = preflight
