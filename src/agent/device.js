// This browser as a DorAI device, for price-drop alerts (worker/devices.ts).
// Made only when the shopper turns alerts on. Its credential lives in
// localStorage for the page, and in Cache storage for the service worker,
// which needs it to fetch alerts when a push arrives (public/sw.js).
import { AGENT_API } from './api.js'

const KEY = 'dorai:device-v1'
const SW_CACHE = 'dorai-device'
const SW_KEY = `${import.meta.env.BASE_URL}__device`

export function loadDevice() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return d && typeof d.token === 'string' ? d : null
  } catch {
    return null
  }
}

async function saveDevice(device) {
  try {
    localStorage.setItem(KEY, JSON.stringify(device))
  } catch {
    // Storage blocked: alerts can't be kept on this browser.
  }
  await caches
    ?.open(SW_CACHE)
    .then((c) => c.put(SW_KEY, new Response(JSON.stringify({ token: device.token }))))
    .catch(() => {})
}

async function call(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${AGENT_API}${path}`, {
    method,
    headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(data?.error ?? `DorAI answered ${response.status}.`), { status: response.status })
  return data
}

export async function ensureDevice(lang) {
  const known = loadDevice()
  if (known) return known
  const made = await call('/device', { method: 'POST', body: { lang } })
  const device = { deviceId: made.deviceId, token: made.token }
  await saveDevice(device)
  return device
}

export const deviceStatus = (device) => call('/device', { token: device.token })

export async function forgetDevice(device) {
  await call('/device', { method: 'DELETE', token: device.token }).catch(() => {})
  const sub = await navigator.serviceWorker?.ready.then((r) => r.pushManager.getSubscription()).catch(() => null)
  await sub?.unsubscribe().catch(() => {})
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing kept
  }
  await caches?.delete(SW_CACHE).catch(() => {})
}

const toWatch = (i) => ({ itemId: i.itemId, site: i.site, name: i.name, url: i.url, image: i.image, savedPrice: i.price, targetPrice: i.targetPrice ?? null })
export const syncWatches = (device, items) => call('/watchlist', { method: 'PUT', token: device.token, body: { watches: items.map(toWatch) } })
export const unwatchOnServer = (device, itemId) => call(`/watchlist?itemId=${encodeURIComponent(itemId)}`, { method: 'DELETE', token: device.token })

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** Asks for notification permission, subscribes, and gives the server the push address. */
export async function enablePush(device, vapidPublicKey) {
  if ((await Notification.requestPermission()) !== 'granted') throw Object.assign(new Error('denied'), { denied: true })
  const registration = await navigator.serviceWorker.ready
  const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }))
  await call('/push', { method: 'PUT', token: device.token, body: { endpoint: subscription.endpoint } })
}

export const testPush = (device) => call('/push', { method: 'POST', token: device.token })
export const telegramLink = (device) => call('/telegram-link', { method: 'POST', token: device.token })
