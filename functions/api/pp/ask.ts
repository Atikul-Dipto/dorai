/**
 * DorAI's shopping agent: /api/pp/ask, called from the page on the same
 * site. The agent itself lives in worker/.
 *
 *   POST { "name": "Jedel KL69 61 Keys RGB Mechanical Keyboard", "details": "under 2000, blue switch" }
 *        name: a product, searched exactly as typed; details: what they need (read by the AI).
 *        Either may be empty, not both.
 *   GET  ?name=...&details=...    the same
 *   GET  ?q=... / POST { "query" } one-box form: the agent works out whether it's a name or a description
 *   POST may add "visitor": the id of a guest who said yes to search history (worker/profiles.ts)
 *
 * An account searches freely; a guest has a few free searches, counted here on
 * every route, then gets 401 { needLogin: true } (worker/access.ts).
 */

import { admit, forGuest, giveBack, historyKey, reply, wall } from '../../../worker/access.ts'
import { type Answer, type AskInput, run } from '../../../worker/agent.ts'
import { readCache, searchKey, writeCache } from '../../../worker/cache.ts'
import { json, preflight } from '../../../worker/http.ts'
import { onThisSite } from '../../../worker/parts.ts'
import { logAsk } from '../../../worker/store.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env; waitUntil(p: Promise<unknown>): void }

const SEARCH_CACHE_SECONDS = 15 * 60

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

function readInput(raw: { name?: unknown; details?: unknown; query?: unknown }): AskInput | string {
  const name = clean(raw.name)
  const details = clean(raw.details)
  const query = clean(raw.query)
  if (name.length > 200 || details.length > 300 || query.length > 200) return 'That is longer than the agent reads — keep it under 200 characters.'
  if (name || details) return name.length + details.length >= 2 ? { name, details } : 'Ask for a product in at least 2 characters.'
  return query.length >= 2 ? { query } : 'Type a product name, or what you need.'
}

async function answer({ request, env, waitUntil }: Ctx, raw: { name?: unknown; details?: unknown; query?: unknown; visitor?: unknown }): Promise<Response> {
  const input = readInput(raw)
  if (typeof input === 'string') return json(request, { error: input }, 400)
  const logged = input.query ?? [input.name, input.details].filter(Boolean).join(' — ')
  const askedAt = new Date().toISOString()
  const access = await admit(request, env, new Date(askedAt))
  if (!access.allowed) return wall(request, access)
  const visitor = await historyKey(env, access, raw.visitor)
  try {
    // The same search within 15 minutes is answered from the cache; an answer
    // where a store couldn't be reached isn't kept.
    const key = await searchKey([input.name, input.details, input.query])
    const hit = await readCache<Answer>(key)
    const result = hit ? { ...hit, cached: true } : await run(input, onThisSite(env, request))
    if (!hit && !result.stores.some((st) => st.note?.startsWith("Couldn't reach"))) waitUntil(writeCache(key, result, SEARCH_CACHE_SECONDS))
    // The cheapest of the stores' recommended options, for the record of how answers went.
    const picks = result.stores.map((st) => st.recommended).filter((r) => r !== null)
    const cheapest = picks.sort((a, b) => a.finalPrice - b.finalPrice)[0] ?? null
    const results = result.stores.reduce((n, st) => n + (st.recommended ? 1 : 0) + st.matches.length, 0)
    if (env.PP_DB) {
      waitUntil(
        logAsk(env.PP_DB, {
          visitor,
          askedAt,
          query: logged,
          mode: result.intent.mode,
          intentSource: result.intent.source,
          results,
          bestPrice: cheapest?.listing.price ?? null,
          bestFinal: cheapest?.finalPrice ?? null,
          voucherApplied: picks.some((r) => r.bestVoucher),
          totalMs: hit ? Date.now() - Date.parse(askedAt) : result.timingsMs.total,
          timings: hit ? { cached: 1 } : result.timingsMs,
          error: null,
        }).catch(() => {}),
      )
    }
    return reply(request, access.guest ? forGuest(result, logged) : result, results ? access : await giveBack(env.PP_DB, access))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (env.PP_DB) {
      waitUntil(
        logAsk(env.PP_DB, { visitor, askedAt, query: logged, mode: '', intentSource: '', results: 0, bestPrice: null, bestFinal: null, voucherApplied: false, totalMs: Date.now() - Date.parse(askedAt), timings: {}, error: message.slice(0, 300) }).catch(() => {}),
      )
    }
    return reply(request, { error: `Couldn't reach Daraz just now (${message}). Try again in a moment.` }, await giveBack(env.PP_DB, access), 502)
  }
}

export const onRequestGet = (ctx: Ctx) => {
  const p = new URL(ctx.request.url).searchParams
  return answer(ctx, { name: p.get('name'), details: p.get('details'), query: p.get('q') })
}

export const onRequestPost = async (ctx: Ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as { name?: unknown; details?: unknown; query?: unknown; visitor?: unknown } | null
  return answer(ctx, body ?? {})
}

export const onRequestOptions = preflight
