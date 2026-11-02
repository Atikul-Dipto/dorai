/**
 * /api/pp/push — this device's Web Push subscription (worker/notify.ts).
 *
 *   PUT  { endpoint }   save the browser's push endpoint
 *   POST                send a test notification now
 *   DELETE              stop push alerts
 */

import { allow, authDevice } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import { sendPush } from '../../../worker/notify.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

// Only the browsers' own push services: the server never posts to an address a page made up.
const PUSH_SERVICES = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)\//i

async function deviceOf({ request, env }: Ctx) {
  if (!env.PP_DB) return { error: json(request, { error: 'Not configured.' }, 503) }
  const device = await authDevice(env.PP_DB, request)
  return device ? { db: env.PP_DB, device } : { error: json(request, { error: 'Unknown device.' }, 401) }
}

export const onRequestPut = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  const body = (await ctx.request.json().catch(() => null)) as { endpoint?: unknown } | null
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  if (!PUSH_SERVICES.test(endpoint) || endpoint.length > 1000) return json(ctx.request, { error: "That isn't a browser push address." }, 400)
  await r.db.prepare(`UPDATE devices SET push_endpoint = ? WHERE id = ?`).bind(endpoint, r.device.id).run()
  return json(ctx.request, { push: true })
}

export const onRequestPost = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  if (!r.device.push_endpoint) return json(ctx.request, { error: 'Push alerts are off on this device.' }, 409)
  if (!(await allow(r.db, `pushtest:${r.device.id}`, 5, 3600, new Date()))) return json(ctx.request, { error: 'Too many test notifications. Try again later.' }, 429)
  // A test is an alert like any other, so the notification has something to show.
  const now = new Date().toISOString()
  await r.db
    .prepare(`INSERT INTO alerts (device_id, item_id, site, name, url, old_price, new_price, created_at, push_status) VALUES (?, 'test', 'daraz', ?, ?, 0, 0, ?, 'test')`)
    .bind(r.device.id, r.device.lang === 'en' ? 'DorAI alerts are on' : 'DorAI অ্যালার্ট চালু আছে', 'https://dorai-bd.pages.dev/', now)
    .run()
  const sent = await sendPush(r.device.push_endpoint, ctx.env)
  if (sent === 'gone') await r.db.prepare(`UPDATE devices SET push_endpoint = NULL WHERE id = ?`).bind(r.device.id).run()
  return json(ctx.request, { sent })
}

export const onRequestDelete = async (ctx: Ctx) => {
  const r = await deviceOf(ctx)
  if ('error' in r) return r.error
  await r.db.prepare(`UPDATE devices SET push_endpoint = NULL WHERE id = ?`).bind(r.device.id).run()
  return json(ctx.request, { push: false })
}

export const onRequestOptions = preflight
