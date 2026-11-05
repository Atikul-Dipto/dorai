// Learning events: what a shopper does with an answer (opens an offer at its
// store, saves it, says it's not what they wanted), sent to /api/pp/events so
// DorAI can learn which picks people actually want. The search, the offer and
// the act; who, only for a shopper who said yes to search history.
import { AGENT_API } from './api.js'
import { visitorId } from './visitor.js'

/** slot: 'pick' (a store's recommended option) or 'match' (a "More" row, with its relation and position). */
export function track(kind, { query, listing, slot = 'pick', relation = null, position = 0 }) {
  if (!query || !listing?.itemId) return
  const body = JSON.stringify({ events: [{ kind, query, itemId: listing.itemId, site: listing.site, slot, relation, position, price: listing.price }], visitor: visitorId() ?? undefined })
  const url = `${AGENT_API}/events`
  try {
    // text/plain needs no preflight, and a beacon still goes as the store's tab opens.
    if (navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return
  } catch {
    // fall through to fetch
  }
  fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {})
}
