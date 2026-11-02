import { createContext, useCallback, useContext, useState } from 'react'
import { loadDevice, syncWatches, unwatchOnServer } from './device.js'

// Saved products, kept in this browser. Each item keeps the price it had
// when saved; "Check price now" asks the compare service (/api/pp/compare)
// for its current price and any cheaper store. Once price-drop alerts are on
// (device.js), every change is also sent to the server copy the scheduled
// price checks read (/api/pp/watchlist).
const KEY = 'dorai:watchlist-v1'
const MAX_ITEMS = 50

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((i) => i && typeof i.itemId === 'string' && typeof i.url === 'string') : []
  } catch {
    return []
  }
}

function save(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    // Storage blocked: the list lasts until the page is closed.
  }
}

// The server copy follows quietly; the next "turn on alerts" or change resends it if this fails.
const toServer = (work) => {
  const device = loadDevice()
  if (device) work(device).catch(() => {})
}

export function useWatchlistState() {
  const [items, setItems] = useState(load)
  const change = useCallback((next) => {
    setItems((list) => {
      const updated = next(list)
      save(updated)
      return updated
    })
  }, [])

  const has = useCallback((itemId) => items.some((i) => i.itemId === itemId), [items])
  const remove = useCallback(
    (itemId) => {
      change((list) => list.filter((i) => i.itemId !== itemId))
      toServer((d) => unwatchOnServer(d, itemId))
    },
    [change],
  )
  const toggle = useCallback(
    (listing) => {
      if (items.some((i) => i.itemId === listing.itemId)) return remove(listing.itemId)
      const item = { itemId: listing.itemId, site: listing.site, name: listing.name, url: listing.url, image: listing.image ?? '', price: listing.price, savedAt: new Date().toISOString(), targetPrice: null, check: null }
      change((list) => [item, ...list.filter((i) => i.itemId !== item.itemId)].slice(0, MAX_ITEMS))
      toServer((d) => syncWatches(d, [item]))
    },
    [items, change, remove],
  )
  const setTarget = useCallback(
    (itemId, targetPrice) => {
      const item = items.find((i) => i.itemId === itemId)
      if (!item) return
      change((list) => list.map((i) => (i.itemId === itemId ? { ...i, targetPrice } : i)))
      toServer((d) => syncWatches(d, [{ ...item, targetPrice }]))
    },
    [items, change],
  )
  const recordCheck = useCallback((itemId, check) => change((list) => list.map((i) => (i.itemId === itemId ? { ...i, check } : i))), [change])
  return { items, has, toggle, remove, setTarget, recordCheck }
}

export const WatchlistContext = createContext(null)
export const useWatchlist = () => useContext(WatchlistContext)
