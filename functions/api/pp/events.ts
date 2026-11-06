/**
 * /api/pp/events — learning events: what shoppers do with an answer
 * (worker/interactions.ts). Sent by the page as a beacon. Linked to a visitor
 * or an account only when the shopper said yes to search history (worker/profiles.ts).
 *
 *   POST { events: [{ kind, query, itemId, site, slot, relation?, position?, price? }], visitor? }   up to 10
 *        kind: open | save | unsave | not_this; slot: pick | match
 *   GET  ?days=7   the owner's readout ("Authorization: Bearer <ADMIN_TOKEN>")
 */

import { historyKey } from '../../../worker/access.ts'
import { sessionUser } from '../../../worker/accounts.ts'
import { allow, callerKey } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import { MAX_EVENTS, readInteraction, recordInteractions, summarizeInteractions } from '../../../worker/interactions.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env & { ADMIN_TOKEN?: string } }

const EVENTS_PER_HOUR = 300

export const onRequestPost = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  // A beacon is sent as text/plain (no preflight), so the body is read as JSON whatever its type.
  const body = (await request.json().catch(() => null)) as { events?: unknown; visitor?: unknown } | null
  const raw = Array.isArray(body?.events) ? body.events : []
  const events = raw.slice(0, MAX_EVENTS).map(readInteraction).filter((e) => e !== null)
  if (!events.length) return json(request, { error: 'Send { events: [{ kind, query, itemId, site, slot }] }.' }, 400)
  const now = new Date()
  if (!(await allow(db, await callerKey(request, env, 'events'), EVENTS_PER_HOUR, 3600, now))) return json(request, { error: 'Too many events. Try again later.' }, 429)
  await recordInteractions(db, events, now.toISOString(), await historyKey(env, { user: await sessionUser(db, request, now) }, body?.visitor))
  return json(request, { recorded: events.length })
}

export const onRequestGet = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json(request, { error: 'Not allowed.' }, 403)
  const days = Math.min(90, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 7))
  return json(request, await summarizeInteractions(db, new Date(Date.now() - days * 86_400_000).toISOString()))
}

export const onRequestOptions = preflight
