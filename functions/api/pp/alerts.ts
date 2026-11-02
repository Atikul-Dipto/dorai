/**
 * /api/pp/alerts — this device's price-drop alerts. The service worker calls
 * it when a push arrives (pushes carry no text; see worker/notify.ts).
 *
 *   GET            the alerts not shown yet, then marked shown
 *   GET ?all=1     the last 20, shown or not (for the watchlist panel)
 */

import { authDevice } from '../../../worker/devices.ts'
import { json, preflight } from '../../../worker/http.ts'
import type { Env } from '../../../worker/types.ts'

type Ctx = { request: Request; env: Env }

export const onRequestGet = async ({ request, env }: Ctx) => {
  const db = env.PP_DB
  if (!db) return json(request, { error: 'Not configured.' }, 503)
  const device = await authDevice(db, request)
  if (!device) return json(request, { error: 'Unknown device.' }, 401)
  const all = new URL(request.url).searchParams.has('all')
  const { results } = await db
    .prepare(
      `SELECT id, item_id AS itemId, site, name, url, old_price AS oldPrice, new_price AS newPrice, created_at AS createdAt, seen_at AS seenAt
         FROM alerts WHERE device_id = ? ${all ? '' : 'AND seen_at IS NULL'} ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(device.id)
    .all<{ id: number }>()
  if (!all && results.length) {
    await db.prepare(`UPDATE alerts SET seen_at = ? WHERE device_id = ? AND seen_at IS NULL`).bind(new Date().toISOString(), device.id).run()
  }
  return json(request, { lang: device.lang, alerts: results })
}

export const onRequestOptions = preflight
