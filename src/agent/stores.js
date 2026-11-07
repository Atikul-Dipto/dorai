export const STORE_LABEL = { daraz: 'Daraz', cartup: 'Cartup', othoba: 'Othoba', startech: 'Star Tech', pickaboo: 'Pickaboo' }

// Electronics can be compared on any three of these (worker/segments.ts); the shopper's three are kept in this browser.
export const ALL_SHOPS = ['daraz', 'cartup', 'othoba', 'startech', 'pickaboo']
export const SHOPS_PER_SEARCH = 3
const SHOPS_KEY = 'dorai:electronics-shops'

export function loadShops() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOPS_KEY) ?? 'null')
    return Array.isArray(saved) && saved.length === SHOPS_PER_SEARCH ? saved : null
  } catch {
    return null
  }
}

export function saveShops(shops) {
  try {
    localStorage.setItem(SHOPS_KEY, JSON.stringify(shops))
  } catch {
    // Storage blocked: the choice lasts this search only.
  }
}

// A Daraz, Cartup or Othoba product link, typed, pasted or shared from their apps.
export const STORE_LINK = /https?:\/\/\S*(daraz\.com\.bd|cartup\.com|othoba\.com)\/\S/i
