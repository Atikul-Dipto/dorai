/**
 * /api/pp/telegram-webhook — Telegram calls this with each message to the
 * DorAI bot (set once with setWebhook; see docs/OPERATIONS.md). Only calls
 * carrying the shared secret header are accepted.
 *
 *   /start <code>   link this chat to the device that made the code
 *   /stop           unlink it
 */

import { sendTelegram } from '../../../worker/notify.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

const ok = () => new Response('ok')

export const onRequestPost = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db || !env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Not allowed.', { status: 403 })
  }
  const update = (await request.json().catch(() => null)) as { message?: { chat?: { id?: number }; text?: string } } | null
  const chat = update?.message?.chat?.id
  const text = (update?.message?.text ?? '').trim()
  if (!chat) return ok()

  const start = /^\/start\s+([A-Za-z0-9_-]{8,40})$/.exec(text)
  if (start) {
    const link = await db.prepare(`SELECT device_id FROM telegram_links WHERE code = ?`).bind(start[1]).first<{ device_id: string }>()
    if (!link) {
      await sendTelegram(String(chat), 'This link has expired. Open your DorAI watchlist and tap "Telegram" again.', env)
      return ok()
    }
    await db.batch([
      db.prepare(`UPDATE devices SET telegram_chat = ? WHERE id = ?`).bind(String(chat), link.device_id),
      db.prepare(`DELETE FROM telegram_links WHERE code = ?`).bind(start[1]),
    ])
    await sendTelegram(String(chat), 'DorAI price-drop alerts are on ✅ — DorAI অ্যালার্ট চালু হয়েছে। Send /stop to turn them off.', env)
    return ok()
  }
  if (text === '/stop') {
    await db.prepare(`UPDATE devices SET telegram_chat = NULL WHERE telegram_chat = ?`).bind(String(chat)).run()
    await sendTelegram(String(chat), 'DorAI alerts are off for this chat.', env)
    return ok()
  }
  await sendTelegram(String(chat), 'To get DorAI price-drop alerts here, open your watchlist on https://dorai-bd.pages.dev and tap "Telegram".', env)
  return ok()
}
