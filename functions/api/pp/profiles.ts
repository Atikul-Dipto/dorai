/**
 * /api/pp/profiles — visitor profiles (worker/profiles.ts). The owner's page
 * is /profiles (public/profiles.html).
 *
 *   GET            everyone with a history ("Authorization: Bearer <ADMIN_TOKEN>")
 *   GET ?id=<key>  one visitor's pattern and latest acts (the same)
 *   DELETE { visitor }   a shopper turning it off, with the id in their browser
 */

import { allow, callerKey } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import { forgetProfile, listProfiles, readProfile, visitorKey } from '../../../worker/profiles.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env & { ADMIN_TOKEN?: string } }

const FORGETS_PER_HOUR = 30

export const onRequestGet = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json(request, { error: 'Not allowed.' }, 403)
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return json(request, { visitors: await listProfiles(db) })
  const profile = await readProfile(db, id)
  return profile ? json(request, profile) : json(request, { error: 'No such visitor.' }, 404)
}

export const onRequestDelete = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const body = (await request.json().catch(() => null)) as { visitor?: unknown } | null
  const key = await visitorKey(env, body?.visitor)
  if (!key) return json(request, { error: 'Send { visitor }.' }, 400)
  if (!(await allow(db, await callerKey(request, env, 'forget'), FORGETS_PER_HOUR, 3600, new Date()))) return json(request, { error: 'Too many requests. Try again later.' }, 429)
  await forgetProfile(db, key)
  return json(request, { forgotten: true })
}

export const onRequestOptions = preflight
