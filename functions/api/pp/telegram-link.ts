/**
 * /api/pp/telegram-link — connect this device to the DorAI Telegram bot.
 *
 *   POST     a one-time link: { url: "https://t.me/<bot>?start=<code>" }. The
 *            shopper opens it and taps Start; the bot's webhook
 *            (telegram-webhook.ts) then knows which chat is this device.
 *   DELETE   stop Telegram alerts
 */

import { authDevice, randomId } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

export const onRequestPost = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_NAME) return json(request, { error: "Telegram alerts aren't set up yet." }, 503)
  const device = await authDevice(db, request)
  if (!device) return json(request, { error: 'Unknown device.' }, 401)
  const code = randomId(12)
  const now = new Date().toISOString()
  const dayAgo = new Date(Date.now() - 86400_000).toISOString()
  await db.batch([
    db.prepare(`DELETE FROM telegram_links WHERE device_id = ? OR created_at < ?`).bind(device.id, dayAgo),
    db.prepare(`INSERT INTO telegram_links (code, device_id, created_at) VALUES (?, ?, ?)`).bind(code, device.id, now),
  ])
  return json(request, { url: `https://t.me/${env.TELEGRAM_BOT_NAME}?start=${code}` })
}

export const onRequestDelete = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const device = await authDevice(db, request)
  if (!device) return json(request, { error: 'Unknown device.' }, 401)
  await db.prepare(`UPDATE devices SET telegram_chat = NULL WHERE id = ?`).bind(device.id).run()
  return json(request, { telegramLinked: false })
}

export const onRequestOptions = preflight
