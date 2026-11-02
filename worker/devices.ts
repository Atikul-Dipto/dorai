/**
 * Users, as anonymous devices: no accounts, no names, no addresses. A device
 * is created when a shopper turns on price-drop alerts; it gets an id and a
 * random secret, and proves itself with "Bearer <id>.<secret>". Only the
 * secret's SHA-256 is stored.
 *
 * Also the write endpoints' rate limits: fixed windows in D1, counted by a
 * salted hash of the caller (never the address itself).
 */

import type { D1Database, Env } from './types.ts'

export interface Device {
  id: string
  lang: string
  push_endpoint: string | null
  telegram_chat: string | null
}

const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))
export const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
export const randomId = (n = 16) => b64url(bytes(n))

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function registerDevice(db: D1Database, lang: string, now: string): Promise<{ deviceId: string; token: string }> {
  const id = randomId(12)
  const secret = randomId(32)
  await db
    .prepare(`INSERT INTO devices (id, token_hash, lang, created_at, last_seen) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, await sha256(secret), lang === 'en' ? 'en' : 'bn', now, now)
    .run()
  return { deviceId: id, token: `${id}.${secret}` }
}

/** The device behind a request's "Authorization: Bearer <id>.<secret>", or null. */
export async function authDevice(db: D1Database, request: Request): Promise<Device | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{8,40})\.([A-Za-z0-9_-]{20,80})$/.exec(request.headers.get('authorization') ?? '')
  if (!m) return null
  const row = await db
    .prepare(`SELECT id, token_hash, lang, push_endpoint, telegram_chat FROM devices WHERE id = ?`)
    .bind(m[1])
    .first<Device & { token_hash: string }>()
  if (!row || row.token_hash !== (await sha256(m[2]))) return null
  const { token_hash: _, ...device } = row
  return device
}

export async function touchDevice(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).bind(now, id).run()
}

/** A salted hash of who's calling, per purpose: the client's address never reaches the database. */
export async function callerKey(request: Request, env: Env, scope: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return `${scope}:${(await sha256(`${env.RATE_SALT ?? 'dorai'}|${scope}|${ip}`)).slice(0, 32)}`
}

/** True while `key` has made at most `limit` calls in the current `windowSeconds` window. */
export async function allow(db: D1Database, key: string, limit: number, windowSeconds: number, now: Date): Promise<boolean> {
  const start = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString()
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END, window_start = ?2
       RETURNING count`,
    )
    .bind(key, start)
    .first<{ count: number }>()
  return (row?.count ?? 0) <= limit
}
