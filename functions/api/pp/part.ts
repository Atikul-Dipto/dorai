/**
 * /api/pp/part — one store read as its own request, called only by this site's
 * own search, so that each gets its own CPU allowance (worker/parts.ts).
 *
 *   POST { name, args }   with the x-dorai-part key   -> { result } or { error }
 */

import { json, preflight } from '../../../worker/http.ts'
import { isPart, onThisSite, partKey, runPart } from '../../../worker/parts.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

export const onRequestPost = async ({ request, env }: Ctx) => {
  if (request.headers.get('x-dorai-part') !== (await partKey(env))) return json(request, { error: 'Not allowed.' }, 403)
  const body = (await request.json().catch(() => null)) as { name?: unknown; args?: unknown } | null
  if (!isPart(body?.name) || !Array.isArray(body?.args)) return json(request, { error: 'Send { name, args }.' }, 400)
  try {
    return json(request, { result: await runPart(onThisSite(env, request), body.name, body.args) })
  } catch (e) {
    return json(request, { error: e instanceof Error ? e.message : String(e) }, 502)
  }
}

export const onRequestOptions = preflight
