/**
 * /api/pp/device — an anonymous device, created when a shopper turns on
 * price-drop alerts (worker/devices.ts).
 *
 *   POST                 a new device: { deviceId, token, vapidPublicKey, telegram }
 *   GET                  this device's alert channels (Authorization: Bearer <token>)
 *   DELETE               forget this device, its watchlist and alerts
 */

import { allow, authDevice, callerKey, registerDevice, touchDevice } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

// A browser makes one device; this only stops a script making thousands.
const SIGNUPS_PER_HOUR = 5

const channels = (env: Env) => ({ vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null, telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_NAME) })

export const onRequestPost = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const now = new Date()
  if (!(await allow(db, await callerKey(request, env, 'signup'), SIGNUPS_PER_HOUR, 3600, now))) return json(request, { error: 'Too many new devices from here. Try again later.' }, 429)
  const body = (await request.json().catch(() => null)) as { lang?: unknown } | null
  const device = await registerDevice(db, String(body?.lang ?? 'bn'), now.toISOString())
  return json(request, { ...device, ...channels(env) }, 201)
}

export const onRequestGet = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const device = await authDevice(db, request)
  if (!device) return json(request, { error: 'Unknown device.' }, 401)
  await touchDevice(db, device.id, new Date().toISOString())
  return json(request, { deviceId: device.id, push: Boolean(device.push_endpoint), telegramLinked: Boolean(device.telegram_chat), ...channels(env) })
}

export const onRequestDelete = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const device = await authDevice(db, request)
  if (!device) return json(request, { error: 'Unknown device.' }, 401)
  await db.batch([
    db.prepare(`DELETE FROM watches WHERE device_id = ?`).bind(device.id),
    db.prepare(`DELETE FROM alerts WHERE device_id = ?`).bind(device.id),
    db.prepare(`DELETE FROM telegram_links WHERE device_id = ?`).bind(device.id),
    db.prepare(`DELETE FROM devices WHERE id = ?`).bind(device.id),
  ])
  return json(request, { deleted: true })
}

export const onRequestOptions = preflight
