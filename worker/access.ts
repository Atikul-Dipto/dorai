/**
 * Who may search. An account searches freely and sees every offer. A guest has
 * GUEST_SEARCHES searches, then the page asks them to log in, and sees
 * GUEST_ROWS of each store's rows beyond its pick.
 *
 * All of it is decided here on the server. A guest is a random cookie, counted
 * by a salted hash of it, so clearing cookies starts a new trial; the daily
 * limit per address stops a script doing that for ever. Mobile networks share
 * addresses between many people, so that limit is well above one person's use.
 * The guest row holds a count, nothing about what was searched.
 */

import { profileKey, readCookie, sessionUser, type User } from './accounts.ts'
import { allow, callerKey, randomId, sha256 } from './devices.ts'
import { json } from './http.ts'
import { visitorKey } from './profiles.ts'
import { compact } from './ranking.ts'
import type { D1Database, Env } from './types.ts'

export const GUEST_SEARCHES = 5
export const GUEST_ROWS = 2
const GUEST_SEARCHES_A_DAY_PER_ADDRESS = 60
const GUEST_COOKIE = 'dorai_guest'
const GUEST_COOKIE_SECONDS = 365 * 86_400
const GUEST_KEEP_DAYS = 365

export interface GuestCount {
  used: number
  limit: number
}

export interface Access {
  allowed: boolean
  user: User | null
  guest: GuestCount | null // null for an account, and for a request that isn't counted
  key: string | null // this guest's row
  cookie: string | null // Set-Cookie for a guest new to the site
}

/** For what the trial doesn't cover: the extension, which has no login. */
export const NOT_COUNTED: Access = { allowed: true, user: null, guest: null, key: null, cookie: null }

const guestKey = async (env: Env, value: string) => (await sha256(`${env.RATE_SALT ?? 'dorai'}|guest|${value}`)).slice(0, 32)

/** How many of their free searches this browser has used. */
export async function guestCount(request: Request, env: Env): Promise<GuestCount> {
  const value = readCookie(request, GUEST_COOKIE)
  const row = value && env.PP_DB ? await env.PP_DB.prepare(`SELECT used FROM guests WHERE key = ?`).bind(await guestKey(env, value)).first<{ used: number }>() : null
  return { used: row?.used ?? 0, limit: GUEST_SEARCHES }
}

/** Counts this search for a guest, or says it's over. An account always passes. */
export async function admit(request: Request, env: Env, now: Date): Promise<Access> {
  const db = env.PP_DB
  if (!db) return NOT_COUNTED
  const user = await sessionUser(db, request, now)
  if (user) return { ...NOT_COUNTED, user }

  const known = readCookie(request, GUEST_COOKIE)
  const value = known ?? randomId(24)
  const key = await guestKey(env, value)
  const cookie = known ? null : `${GUEST_COOKIE}=${value}; Path=/; Max-Age=${GUEST_COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  const at = now.toISOString()
  const refused: Access = { allowed: false, user: null, guest: { used: GUEST_SEARCHES, limit: GUEST_SEARCHES }, key, cookie }

  if (!(await allow(db, await callerKey(request, env, 'guest'), GUEST_SEARCHES_A_DAY_PER_ADDRESS, 86_400, now))) return refused
  // One statement, so two searches at once can't both take the last one.
  const row = await db
    .prepare(
      `INSERT INTO guests (key, used, first_at, last_at) VALUES (?1, 1, ?2, ?2)
       ON CONFLICT(key) DO UPDATE SET used = used + 1, last_at = ?2 WHERE used < ?3
       RETURNING used`,
    )
    .bind(key, at, GUEST_SEARCHES)
    .first<{ used: number }>()
  if (!row) return refused
  return { allowed: true, user: null, guest: { used: row.used, limit: GUEST_SEARCHES }, key, cookie }
}

/** Whose search history this joins, if anyone's: an account that said yes, or a guest browser that did. */
export async function historyKey(env: Env, who: { user: User | null }, visitor: unknown): Promise<string | null> {
  if (who.user) return who.user.history ? profileKey(who.user) : null
  return visitorKey(env, visitor)
}

/** The answer, with a guest's count and their cookie when they're new. */
export function reply(request: Request, body: object, access: Access, status = 200): Response {
  const response = json(request, access.guest ? { ...body, guest: access.guest } : body, status)
  if (access.cookie) response.headers.append('set-cookie', access.cookie)
  return response
}

/** The free searches are over. */
export const wall = (request: Request, access: Access) => reply(request, { error: 'Log in to keep searching.', needLogin: true }, access, 401)

/** A search that failed or found nothing doesn't use up a free one. */
export async function giveBack(db: D1Database | undefined, access: Access): Promise<Access> {
  if (!db || !access.key || !access.guest) return access
  await db.prepare(`UPDATE guests SET used = MAX(0, used - 1) WHERE key = ?`).bind(access.key).run()
  return { ...access, guest: { ...access.guest, used: Math.max(0, access.guest.used - 1) } }
}

/**
 * What a guest sees of an answer: each store's pick and first rows, and how
 * many more an account would show. A row with exactly the name they searched
 * for is never held back, wherever it ranks.
 */
export function forGuest<T extends { stores: { matches: { listing: { name: string } }[] }[] }>(answer: T, title: string): T {
  const named = compact(title)
  const stores = answer.stores.map((s) => {
    const kept = s.matches.filter((m, i) => i < GUEST_ROWS || compact(m.listing.name) === named)
    return kept.length < s.matches.length ? { ...s, matches: kept, hiddenMatches: s.matches.length - kept.length } : s
  })
  return { ...answer, stores }
}

/** Guests who haven't been back in a year go; a browser that returns after that gets a new trial. */
export async function tidyGuests(db: D1Database, now: Date): Promise<void> {
  await db.prepare(`DELETE FROM guests WHERE last_at < ?`).bind(new Date(now.getTime() - GUEST_KEEP_DAYS * 86_400_000).toISOString()).run()
}
