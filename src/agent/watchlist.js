import { createContext, useCallback, useContext, useState } from 'react'

// Saved products, kept in this browser only (no accounts yet). Each item
// keeps the price it had when saved; "Check price now" asks the compare
// service (/api/pp/compare) for its current price and any cheaper store.
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
  const toggle = useCallback(
    (listing) =>
      change((list) =>
        list.some((i) => i.itemId === listing.itemId)
          ? list.filter((i) => i.itemId !== listing.itemId)
          : [
              { itemId: listing.itemId, site: listing.site, name: listing.name, url: listing.url, image: listing.image ?? '', price: listing.price, savedAt: new Date().toISOString(), check: null },
              ...list,
            ].slice(0, MAX_ITEMS),
      ),
    [change],
  )
  const remove = useCallback((itemId) => change((list) => list.filter((i) => i.itemId !== itemId)), [change])
  const recordCheck = useCallback((itemId, check) => change((list) => list.map((i) => (i.itemId === itemId ? { ...i, check } : i))), [change])
  return { items, has, toggle, remove, recordCheck }
}

export const WatchlistContext = createContext(null)
export const useWatchlist = () => useContext(WatchlistContext)
