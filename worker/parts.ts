/**
 * Store reads as requests of their own. Cloudflare's free plan allows 10 ms of
 * CPU per request and a search needs about 30, nearly all of it reading what
 * the stores send back. Going over now and then is tolerated, but going over
 * consistently gets requests killed (error 1102), so search failed whenever it
 * was busy. A request this site makes to itself gets its own 10 ms (measured:
 * the caller was charged 1-2 ms, each store 3-13), so each read below runs that
 * way, through /api/pp/part, and the search only combines the results. A store's
 * product and category pages are requests of their own too, and so is saving
 * what was seen. Linked Workers wouldn't help: those share the caller's budget.
 *
 * With no env.SELF everything runs in place, as the tests and scheduled jobs do.
 */

import * as cartup from './cartup.ts'
import * as daraz from './daraz.ts'
import { sha256 } from './devices.ts'
import * as othoba from './othoba.ts'
import * as pickaboo from './pickaboo.ts'
import * as startech from './startech.ts'
import * as store from './store.ts'
import { type ItemRef, type Site, STORES } from './stores.ts'
import type { Env, Listing } from './types.ts'

const PART_TIMEOUT_MS = 20_000
const keys = new Map<string, Promise<string>>()

/** Everything that can run as its own request. Arguments and results are plain JSON. */
const PARTS = {
  darazSearch: (_env: Env, query: string, opts?: Parameters<typeof daraz.search>[1]) => daraz.search(query, opts),
  darazCategory: (_env: Env, url: string) => daraz.productCategory(url),
  darazTitle: (_env: Env, url: string) => daraz.productTitle(url),
  darazProduct: (_env: Env, url: string, itemId: string) => daraz.fetchProduct(url, itemId),
  cartupLookup: (env: Env, title: string): Promise<cartup.CartupLookup> => cartup.lookup(env.PP_DB, title, (slug) => callPart(env, 'cartupProduct', slug)),
  cartupBrowse: (env: Env, kinds: string[]): Promise<cartup.Browsed> => cartup.browse(env.PP_DB, kinds, (category) => callPart(env, 'cartupCategory', category)),
  cartupCategory: (_env: Env, category: string) => cartup.fetchCategory(category),
  cartupEnrich: (_env: Env, listings: Listing[]) => cartup.enrich(listings),
  cartupProduct: (_env: Env, slug: string) => cartup.fetchProduct(slug),
  othobaLookup: (env: Env, title: string): Promise<cartup.CartupLookup> => othoba.lookup(env.PP_DB, title, (slug) => callPart(env, 'othobaProduct', slug)),
  othobaProduct: (_env: Env, slug: string) => othoba.fetchProduct(slug),
  startechSearch: (_env: Env, query: string) => startech.search(query),
  pickabooSearch: (_env: Env, query: string) => pickaboo.search(query),
  storeCurrent: (env: Env, site: Site, item: ItemRef) => STORES[site].current(item, env),
  remember: async (env: Env, listings: Listing[], now: string) => {
    if (env.PP_DB) await store.recordListings(env.PP_DB, listings, now)
  },
}

export type PartName = keyof typeof PARTS
type Rest<T> = T extends (env: Env, ...args: infer A) => unknown ? A : never

export const isPart = (name: unknown): name is PartName => typeof name === 'string' && Object.hasOwn(PARTS, name)

/** The key that proves a part request comes from this site: the search's limits can't be got round through it. */
export function partKey(env: Env): Promise<string> {
  const salt = env.RATE_SALT ?? 'dorai'
  const known = keys.get(salt) ?? sha256(`${salt}|part`)
  keys.set(salt, known)
  return known
}

/** Runs a part here and now. */
export const runPart = (env: Env, name: PartName, args: unknown[]) => (PARTS[name] as (env: Env, ...args: unknown[]) => Promise<unknown>)(env, ...args)

/** A request's env, so its store reads run as their own requests to this same site. */
export const onThisSite = (env: Env, request: Request): Env => ({ ...env, SELF: new URL(request.url).origin })

/** Runs a part as its own request when env.SELF says where. A store that fails rejects, as it would in place. */
export async function callPart<N extends PartName>(env: Env, name: N, ...args: Rest<(typeof PARTS)[N]>): Promise<Awaited<ReturnType<(typeof PARTS)[N]>>> {
  type Result = Awaited<ReturnType<(typeof PARTS)[N]>>
  if (!env.SELF) return (await runPart(env, name, args)) as Result
  // The name in the address labels this read in Cloudflare's logs.
  const response = await fetch(`${env.SELF}/api/pp/part?${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dorai-part': await partKey(env) },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(PART_TIMEOUT_MS),
  })
  const body = (await response.json().catch(() => null)) as { result?: Result; error?: string } | null
  if (!response.ok || !body) throw new Error(body?.error ?? `Part ${name} answered ${response.status}.`)
  return body.result as Result
}
