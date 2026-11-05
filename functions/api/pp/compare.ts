/**
 * DorAI's compare: one product a shopper is looking at, on every store. Called
 * by the browser extension (from a Daraz or Cartup product page) and the
 * installable web app (a product shared from the Daraz or Cartup app).
 *
 *   GET  ?link=<product URL, or the text an app shares>&name=<the page's product title>
 *   POST { "link": "...", "name": "...", "visitor"?: "..." }   visitor: from the site, for a shopper
 *        who said yes to search history (worker/profiles.ts); the extension never sends one
 *
 * The comparison itself lives in worker/compare.ts.
 */

import { compare, resolveShared } from '../../../worker/compare.ts'
import { json, preflight } from '../../../worker/http.ts'
import { visitorKey } from '../../../worker/profiles.ts'
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
  const result = await compare(ref, env, { name })
  const visitor = await visitorKey(env, raw.visitor)
  // A cached repeat still belongs in a shopper's history.
  if (env.PP_DB && (visitor || !('cached' in result && result.cached))) {
    waitUntil(
      logAsk(env.PP_DB, {
        visitor,
        askedAt,
        query: ref.url,
        mode: 'compare',
        intentSource: '',
        results: 'error' in result ? 0 : result.stores.reduce((n, s) => n + (s.recommended ? 1 : 0) + s.matches.length, 0),
        bestPrice: 'error' in result ? null : result.source.listing.price,
        bestFinal: 'error' in result ? null : result.source.finalPrice,
        voucherApplied: false,
        totalMs: Date.now() - Date.parse(askedAt),
        timings: {},
        error: 'error' in result ? result.error : null,
      }).catch(() => {}),
    )
  }
  return 'error' in result ? json(request, result, 502) : json(request, result)
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
