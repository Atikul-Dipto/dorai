/**
 * The notification service: a price-drop alert, recorded in D1 `alerts`,
 * then sent to each channel the device turned on.
 *
 * Push: a Web Push message with no payload, signed with the VAPID key
 * (RFC 8292). The service worker (public/sw.js) wakes, fetches the device's
 * unseen alerts from /api/pp/alerts and shows them. No payload means no
 * message encryption to get wrong, and alert text never passes through the
 * browser vendors' push servers.
 *
 * Telegram: a message from the DorAI bot to the chat the device linked
 * (/api/pp/telegram). Off until the bot's token is set.
 */

import { b64url } from './devices.ts'
import { money } from './eligibility.ts'
import type { D1Database, Env } from './types.ts'

export interface AlertInput {
  deviceId: string
  itemId: string
  site: string
  name: string
  url: string
  oldPrice: number
  newPrice: number
  lang: string
  pushEndpoint: string | null
  telegramChat: string | null
}

const SITE_LABEL: Record<string, string> = { daraz: 'Daraz', cartup: 'Cartup', othoba: 'Othoba' }
const enc = (s: string) => new TextEncoder().encode(s)

/** The "vapid t=<JWT>, k=<public key>" header for a push service, signed ES256. */
async function vapidAuthorization(endpoint: string, env: Env): Promise<string> {
  const header = b64url(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://dorai-bd.pages.dev/' })))
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${header}.${claims}`))
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`
}

/** 'gone' means the browser dropped the subscription: forget it. */
export async function sendPush(endpoint: string, env: Env): Promise<'sent' | 'gone' | 'failed'> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return 'failed'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: await vapidAuthorization(endpoint, env), ttl: String(24 * 3600), urgency: 'normal', 'content-length': '0' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!response) return 'failed'
  if (response.status === 404 || response.status === 410) return 'gone'
  return response.ok ? 'sent' : 'failed'
}

export async function sendTelegram(chatId: string, text: string, env: Env): Promise<'sent' | 'failed'> {
  if (!env.TELEGRAM_BOT_TOKEN) return 'failed'
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  return response?.ok ? 'sent' : 'failed'
}

export function alertText(a: Pick<AlertInput, 'name' | 'site' | 'oldPrice' | 'newPrice' | 'url' | 'lang'>): string {
  const store = SITE_LABEL[a.site] ?? a.site
  return a.lang === 'en'
    ? `Price drop on ${store}: ${a.name}\n${money(a.oldPrice)} → ${money(a.newPrice)}\n${a.url}`
    : `${store}-এ দাম কমেছে: ${a.name}\n${money(a.oldPrice)} → ${money(a.newPrice)}\n${a.url}`
}

/** Records the alert, sends it on every channel the device has, and keeps each channel's outcome. */
export async function notify(db: D1Database, env: Env, a: AlertInput, now: string): Promise<void> {
  const row = await db
    .prepare(`INSERT INTO alerts (device_id, item_id, site, name, url, old_price, new_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(a.deviceId, a.itemId, a.site, a.name, a.url, a.oldPrice, a.newPrice, now)
    .first<{ id: number }>()
  const [push, telegram] = await Promise.all([
    a.pushEndpoint ? sendPush(a.pushEndpoint, env) : Promise.resolve(null),
    a.telegramChat ? sendTelegram(a.telegramChat, alertText(a), env) : Promise.resolve(null),
  ])
  await db.batch([
    db.prepare(`UPDATE alerts SET push_status = ?, telegram_status = ? WHERE id = ?`).bind(push, telegram, row?.id ?? 0),
    db.prepare(`UPDATE watches SET alerted_price = ? WHERE device_id = ? AND item_id = ?`).bind(a.newPrice, a.deviceId, a.itemId),
    ...(push === 'gone' ? [db.prepare(`UPDATE devices SET push_endpoint = NULL WHERE id = ?`).bind(a.deviceId)] : []),
  ])
}
