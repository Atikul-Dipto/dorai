// DorAI's service worker. It makes the page installable as an app (and, on
// Android, a target for Share in the Daraz, Cartup and Othoba apps), keeps
// the last copy of the page's own files for when the connection drops, and
// shows price-drop alerts. Prices and answers are never cached here: they
// come from the agent, live.
const CACHE = 'dorai-page-v2'
// The device's alert credential, put here by the page (src/agent/device.js).
const DEVICE_CACHE = 'dorai-device'
const BASE = new URL('./', self.location).pathname // "/"
const STORE = { daraz: 'Daraz', cartup: 'Cartup', othoba: 'Othoba' }
const money = (v) => `৳${Math.round(v).toLocaleString('en-US')}`

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DEVICE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return
  // The agent's answers and prices always come from the network.
  if (url.pathname.startsWith(`${BASE}api/`)) return
  // The network first; the last copy when offline. A shared link's page
  // (?url=...) is the same page, so it's stored once, without the query.
  const key = event.request.mode === 'navigate' ? BASE : event.request
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(key, copy))
        }
        return response
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())),
  )
})

// A push carries no text (worker/notify.ts): it means "this device has new
// alerts". They're fetched with the device's credential and shown.
async function showAlerts() {
  let alerts = []
  let lang = 'bn'
  try {
    const credential = await (await caches.open(DEVICE_CACHE)).match(`${BASE}__device`)
    const { token } = credential ? await credential.json() : {}
    if (token) {
      const response = await fetch(`${BASE}api/pp/alerts`, { headers: { authorization: `Bearer ${token}` } })
      if (response.ok) ({ alerts, lang } = await response.json())
    }
  } catch {
    // Offline or signed out: the general notice below.
  }
  const en = lang === 'en'
  if (!alerts.length) {
    await self.registration.showNotification('DorAI', { body: en ? 'A price dropped on your watchlist.' : 'আপনার ওয়াচলিস্টে দাম কমেছে।', icon: `${BASE}icon-192.png`, data: { url: BASE } })
    return
  }
  for (const a of alerts.slice(0, 3)) {
    const test = a.itemId === 'test'
    await self.registration.showNotification(test ? a.name : `${en ? 'Price drop' : 'দাম কমেছে'}: ${money(a.newPrice)}`, {
      body: test
        ? en
          ? "You'll get a notification like this when a saved product gets cheaper."
          : 'সেভ করা পণ্যের দাম কমলে এভাবে জানানো হবে।'
        : `${a.name}\n${money(a.oldPrice)} → ${money(a.newPrice)} · ${STORE[a.site] ?? a.site}`,
      icon: `${BASE}icon-192.png`,
      badge: `${BASE}favicon-32.png`,
      tag: `dorai-alert-${a.id}`,
      data: { url: test ? BASE : `${BASE}?link=${encodeURIComponent(a.url)}` },
    })
  }
}

self.addEventListener('push', (event) => event.waitUntil(showAlerts()))

// Tapping an alert opens its comparison on every store.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? BASE, self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const page = open.find((c) => c.url.startsWith(self.location.origin))
      return page ? page.navigate(url).then((c) => c?.focus()) : self.clients.openWindow(url)
    }),
  )
})
