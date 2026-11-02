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
  const { totals, tracked, recent } = await stats(env.PP_DB)
  const admin = Boolean(env.ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`
  return json(request, admin ? { totals, tracked, recent } : { totals, tracked })
}

export const onRequestOptions = preflight
