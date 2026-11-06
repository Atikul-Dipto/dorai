/**
 * /api/pp/auth — accounts (worker/accounts.ts) and the guest trial
 * (worker/access.ts). A session is an HttpOnly cookie.
 *
 *   GET                                 { user, guest }: who this is, and their free searches
 *   POST { action: "signup", email, password, history?, visitor? }
 *   POST { action: "login", email, password, visitor? }
 *   POST { action: "logout" }
 *   POST { action: "reset", email, code, password }   a forgotten password, with the recovery code
 *   POST { action: "history", on }      search history on, or off and deleted
 *   DELETE { password }                 the account and its history
 *
 * visitor: the id of a guest who said yes to search history; what's kept under
 * it joins the account. Refusals carry a `code` the page shows in its language.
 */

import { guestCount } from '../../../worker/access.ts'
import { adoptGuestHistory, createUser, deleteAccount, endCookie, endSession, goodPassword, logIn, readEmail, resetPassword, sessionUser, setHistory, startSession, type User } from '../../../worker/accounts.ts'
import { allow, callerKey, sha256 } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import { visitorKey } from '../../../worker/profiles.ts'
import type { D1Database, Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }
type Body = { action?: unknown; email?: unknown; password?: unknown; code?: unknown; history?: unknown; on?: unknown; visitor?: unknown }

const PER_ADDRESS_AN_HOUR = { signup: 10, login: 30, reset: 10 }
const PER_ACCOUNT_AN_HOUR = 10

const refuse = (request: Request, code: string, status: number) => json(request, { error: code, code }, status)
const signedIn = (response: Response, cookie: string) => {
  response.headers.append('set-cookie', cookie)
  return response
}
const shape = (user: User) => ({ email: user.email, history: user.history })

const addressAllows = async ({ request, env }: Ctx, db: D1Database, action: keyof typeof PER_ADDRESS_AN_HOUR, now: Date) =>
  allow(db, await callerKey(request, env, action), PER_ADDRESS_AN_HOUR[action], 3600, now)
const accountAllows = async (db: D1Database, action: string, email: string, now: Date) => allow(db, `${action}:${(await sha256(email)).slice(0, 32)}`, PER_ACCOUNT_AN_HOUR, 3600, now)

async function adopt(ctx: Ctx, db: D1Database, user: User, visitor: unknown) {
  const key = await visitorKey(ctx.env, visitor)
  if (key && user.history) await adoptGuestHistory(db, user, key)
}

export const onRequestGet = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const user = await sessionUser(db, request, new Date())
  return json(request, { user: user ? shape(user) : null, guest: user ? null : await guestCount(request, env) })
}

export const onRequestPost = async (ctx: Ctx) => {
  const { request, env } = ctx
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const body = ((await request.json().catch(() => null)) ?? {}) as Body
  const now = new Date()

  if (body.action === 'logout') {
    await endSession(db, request)
    return signedIn(json(request, { user: null, guest: await guestCount(request, env) }), endCookie)
  }

  if (body.action === 'history') {
    const user = await sessionUser(db, request, now)
    if (!user) return refuse(request, 'notSignedIn', 401)
    await setHistory(db, user, body.on === true)
    return json(request, { user: shape({ ...user, history: body.on === true }) })
  }

  const email = readEmail(body.email)
  if (body.action === 'signup') {
    if (!email) return refuse(request, 'badEmail', 400)
    if (!goodPassword(body.password)) return refuse(request, 'shortPassword', 400)
    if (!(await addressAllows(ctx, db, 'signup', now))) return refuse(request, 'tooMany', 429)
    const made = await createUser(db, email, body.password, body.history === true, now.toISOString())
    if (!made) return refuse(request, 'taken', 409)
    await adopt(ctx, db, made.user, body.visitor)
    return signedIn(json(request, { user: shape(made.user), recoveryCode: made.recoveryCode }, 201), await startSession(db, made.user, now))
  }

  if (body.action === 'login') {
    if (!email || typeof body.password !== 'string') return refuse(request, 'wrong', 401)
    if (!(await addressAllows(ctx, db, 'login', now)) || !(await accountAllows(db, 'login', email, now))) return refuse(request, 'tooMany', 429)
    const user = await logIn(db, email, body.password)
    if (!user) return refuse(request, 'wrong', 401)
    await adopt(ctx, db, user, body.visitor)
    return signedIn(json(request, { user: shape(user) }), await startSession(db, user, now))
  }

  if (body.action === 'reset') {
    if (!goodPassword(body.password)) return refuse(request, 'shortPassword', 400)
    if (!email || typeof body.code !== 'string') return refuse(request, 'badCode', 401)
    if (!(await addressAllows(ctx, db, 'reset', now)) || !(await accountAllows(db, 'reset', email, now))) return refuse(request, 'tooMany', 429)
    const done = await resetPassword(db, email, body.code, body.password)
    if (!done) return refuse(request, 'badCode', 401)
    return signedIn(json(request, { user: shape(done.user), recoveryCode: done.recoveryCode }), await startSession(db, done.user, now))
  }

  return refuse(request, 'badAction', 400)
}

export const onRequestDelete = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const now = new Date()
  const user = await sessionUser(db, request, now)
  if (!user) return refuse(request, 'notSignedIn', 401)
  const body = ((await request.json().catch(() => null)) ?? {}) as Body
  if (!(await accountAllows(db, 'delete', user.email, now))) return refuse(request, 'tooMany', 429)
  if (typeof body.password !== 'string' || !(await logIn(db, user.email, body.password))) return refuse(request, 'wrong', 401)
  await deleteAccount(db, user)
  return signedIn(json(request, { user: null, guest: await guestCount(request, env) }), endCookie)
}

export const onRequestOptions = preflight
