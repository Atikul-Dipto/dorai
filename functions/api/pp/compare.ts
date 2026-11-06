/**
 * DorAI's compare: one product a shopper is looking at, on every store. Called
 * by the browser extension (from a Daraz or Cartup product page) and the
 * installable web app (a product shared from the Daraz or Cartup app).
 *
 *   GET  ?link=<product URL, or the text an app shares>&name=<the page's product title>
 *   POST { "link": "...", "name": "...", "visitor"?: "..." }   from the site: counts as a search
 *        for a guest (worker/access.ts); visitor is a guest who said yes to search history
 *
 * GET is the extension's: it has no login, so it isn't counted, and it never sends a visitor.
 *
 * A listing that's gone needn't be a dead end: from the site, its name (in the
 * address) is searched for instead, and the answer says so in `fromLink`.
 *
 * The comparison itself lives in worker/compare.ts.
 */

import { admit, forGuest, giveBack, historyKey, NOT_COUNTED, reply, wall } from '../../../worker/access.ts'
import { type Answer, run } from '../../../worker/agent.ts'
import { compare, resolveShared } from '../../../worker/compare.ts'
import { json, preflight } from '../../../worker/http.ts'
import { onThisSite } from '../../../worker/parts.ts'
import { logAsk } from '../../../worker/store.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env; waitUntil(p: Promise<unknown>): void }

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

async function answer({ request, env, waitUntil }: Ctx, raw: { link?: unknown; name?: unknown; visitor?: unknown }): Promise<Response> {
  const link = clean(raw.link, 600)
  const name = clean(raw.name, 200)
  if (!link) return json(request, { error: 'Share or paste a Daraz or Cartup product link.' }, 400)
  const askedAt = new Date().toISOString()
  const ref = await resolveShared(link)
  if (!ref) return json(request, { error: "That isn't a Daraz or Cartup product link." }, 400)
  const access = request.method === 'POST' ? await admit(request, env, new Date(askedAt)) : NOT_COUNTED
  if (!access.allowed) return wall(request, access)
  const here = onThisSite(env, request)
  const result = await compare(ref, here, { name })
  const worthAsking = request.method === 'POST' && 'error' in result ? result.searchInstead : null
  const instead: Answer | null = worthAsking ? await run({ name: worthAsking, details: '' }, here).catch(() => null) : null
  const rows = (stores: Answer['stores']) => stores.reduce((n, s) => n + (s.recommended ? 1 : 0) + s.matches.length, 0)
  const found = instead && rows(instead.stores) > 0 ? instead : null
  const visitor = await historyKey(env, access, raw.visitor)
  // A cached repeat still belongs in a shopper's history.
  if (env.PP_DB && (visitor || !('cached' in result && result.cached))) {
    waitUntil(
      logAsk(env.PP_DB, {
        visitor,
        askedAt,
        query: ref.url,
        mode: 'compare',
        intentSource: '',
        results: 'error' in result ? (found ? rows(found.stores) : 0) : rows(result.stores),
        bestPrice: 'error' in result ? null : result.source.listing.price,
        bestFinal: 'error' in result ? null : result.source.finalPrice,
        voucherApplied: false,
        totalMs: Date.now() - Date.parse(askedAt),
        timings: {},
        error: 'error' in result && !found ? result.error : null,
      }).catch(() => {}),
    )
  }
  if (!('error' in result)) return reply(request, access.guest ? forGuest(result, result.source.listing.name) : result, access)
  if (!found) return reply(request, { error: result.error }, await giveBack(env.PP_DB, access), 502)
  const shown = { ...found, fromLink: { site: ref.site, label: result.label } }
  return reply(request, access.guest ? forGuest(shown, worthAsking ?? '') : shown, access)
}

export const onRequestOptions = preflight

export const onRequestGet = (ctx: Ctx) => {
  const params = new URL(ctx.request.url).searchParams
  return answer(ctx, { link: params.get('link'), name: params.get('name') })
}

export const onRequestPost = async (ctx: Ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as { link?: unknown; name?: unknown; visitor?: unknown } | null
  return body ? answer(ctx, body) : json(ctx.request, { error: 'Send JSON: { "link": "..." }' }, 400)
}
