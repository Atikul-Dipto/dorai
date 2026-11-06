/**
 * Accounts: an email and a password, kept signed in by a session cookie.
 *
 * Passwords are stored as PBKDF2-SHA256. Cloudflare's runtime refuses more than
 * 100,000 rounds, below the 600,000 now recommended, so rounds are stored per
 * user and a stronger hash can replace them at the next login.
 *
 * DorAI can't send email yet, so addresses aren't verified and a forgotten
 * password is recovered with a one-time code shown when the account is made.
 * The session cookie is HttpOnly: page scripts can't read it.
 */

import { b64url, randomId, sha256 } from './devices.ts'
import { forgetProfile, mergeProfile } from './profiles.ts'
import type { D1Database } from './types.ts'

const SESSION_COOKIE = 'dorai_session'
const SESSION_DAYS = 90
const ROUNDS = 100_000
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32, none easily misread

export interface User {
  id: number
  email: string
  history: boolean
}

interface UserRow {
  id: number
  email: string
  history: number
  password_hash: string
  password_salt: string
  rounds: number
  recovery_hash: string
}

const toUser = (r: { id: number; email: string; history: number }): User => ({ id: r.id, email: r.email, history: Boolean(r.history) })

/** The key a user's searches are filed under when they said yes to search history. */
export const profileKey = (user: Pick<User, 'id'>) => `u${user.id}`

export function readEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

export const goodPassword = (raw: unknown): raw is string => typeof raw === 'string' && raw.length >= MIN_PASSWORD && raw.length <= MAX_PASSWORD

async function derive(password: string, salt: string, rounds: number): Promise<string> {
  const text = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveBits'])
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: text.encode(salt), iterations: rounds }, key, 256))
}

function newCode(): string {
  const letters = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => CODE_LETTERS[b % 32]).join('')
  return letters.match(/.{4}/g)!.join('-')
}

const codeHash = (code: string) => sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ''))

/** A new account and its recovery code, or null when the address already has one. */
export async function createUser(db: D1Database, email: string, password: string, history: boolean, now: string): Promise<{ user: User; recoveryCode: string } | null> {
  const salt = randomId(16)
  const recoveryCode = newCode()
  const row = await db
    .prepare(
      `INSERT INTO users (email, password_hash, password_salt, rounds, recovery_hash, history, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id`,
    )
    .bind(email, await derive(password, salt, ROUNDS), salt, ROUNDS, await codeHash(recoveryCode), history ? 1 : 0, now)
    .first<{ id: number }>()
  return row ? { user: { id: row.id, email, history }, recoveryCode } : null
}

/** The user, when the password is right. An unknown address takes as long as a wrong password. */
export async function logIn(db: D1Database, email: string, password: string): Promise<User | null> {
  const row = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>()
  const hash = await derive(password, row?.password_salt ?? 'no such user', row?.rounds ?? ROUNDS)
  return row && hash === row.password_hash ? toUser(row) : null
}

/** A new password with the recovery code, which is spent: a new one comes back, and every session ends. */
export async function resetPassword(db: D1Database, email: string, code: string, password: string): Promise<{ user: User; recoveryCode: string } | null> {
  const row = await db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<UserRow>()
  if (!row || row.recovery_hash !== (await codeHash(code))) return null
  const salt = randomId(16)
  const recoveryCode = newCode()
  await db.batch([
    db
      .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, rounds = ?, recovery_hash = ? WHERE id = ?`)
      .bind(await derive(password, salt, ROUNDS), salt, ROUNDS, await codeHash(recoveryCode), row.id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.id),
  ])
  return { user: toUser(row), recoveryCode }
}

function cookie(value: string, maxAge: number) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
}

export const endCookie = cookie('', 0)

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, value] = part.trim().split('=')
    if (key === name && value) return value
  }
  return null
}

/** Signs a user in: the Set-Cookie for a new session. Only the token's hash is stored. */
export async function startSession(db: D1Database, user: Pick<User, 'id'>, now: Date): Promise<string> {
  const token = randomId(32)
  await db
    .prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256(token), user.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString())
    .run()
  return cookie(token, SESSION_DAYS * 86_400)
}

/** The user behind a request's session cookie, or null. */
export async function sessionUser(db: D1Database, request: Request, now: Date): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null
  const row = await db
    .prepare(`SELECT u.id, u.email, u.history FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256(token), now.toISOString())
    .first<{ id: number; email: string; history: number }>()
  return row ? toUser(row) : null
}

export async function endSession(db: D1Database, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE)
  if (token) await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run()
}

/** Search history on an account: on, or off and deleted. */
export async function setHistory(db: D1Database, user: User, on: boolean): Promise<void> {
  await db.prepare(`UPDATE users SET history = ? WHERE id = ?`).bind(on ? 1 : 0, user.id).run()
  if (!on) await forgetProfile(db, profileKey(user))
}

/** What a browser kept as a guest who said yes comes along to their account. */
export const adoptGuestHistory = (db: D1Database, user: User, guestKey: string) => mergeProfile(db, guestKey, profileKey(user))

/** The account, its sessions and its search history. */
export async function deleteAccount(db: D1Database, user: User): Promise<void> {
  await forgetProfile(db, profileKey(user))
  await db.batch([db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id), db.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id)])
}

/** Once a day: spent sessions go. */
export async function tidySessions(db: D1Database, now: Date): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now.toISOString()).run()
}
