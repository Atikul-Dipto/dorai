/**
 * /api/pp/health — each shop's last self-check and the database's
 * (worker/health.ts, run twice an hour by the jobs worker). Public: nothing
 * here is about anyone, and a shopper wondering why a shop is empty can see.
 */

import { readHealth } from '../../../worker/health.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { Env } from '../../../worker/types.ts'

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  if (!env.PP_DB) return json(request, { error: 'Not configured.' }, 503)
  const shops = await readHealth(env.PP_DB).catch(() => null)
  if (!shops) return json(request, { error: "The record can't be read right now: the database is out of reach." }, 503)
  return json(request, { shops })
}

export const onRequestOptions = preflight
