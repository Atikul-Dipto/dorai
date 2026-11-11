/**
 * /api/pp/stats — how the agent is doing in real use. Totals are public;
 * the list of recent questions is not (people type what they type), so it
 * needs "Authorization: Bearer <ADMIN_TOKEN>" (a Pages secret; the local
 * copy is in .dev.vars, which is never committed).
 */

import { json, preflight } from '../../../worker/http.ts'
import { stats } from '../../../worker/store.ts'
import type { Env } from '../../../worker/types.ts'

export const onRequestGet = async ({ request, env }: { request: Request; env: Env & { ADMIN_TOKEN?: string } }) => {
  if (!env.PP_DB) return json(request, { error: 'Not configured.' }, 503)
  const read = await stats(env.PP_DB).catch(() => null)
  // The database can be out of reach (the free plan's daily reads used up): say so, don't crash.
  if (!read) return json(request, { error: "The agent's record can't be read right now." }, 503)
  const { totals, tracked, recent } = read
  const admin = Boolean(env.ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`
  return json(request, admin ? { totals, tracked, recent } : { totals, tracked })
}

export const onRequestOptions = preflight
