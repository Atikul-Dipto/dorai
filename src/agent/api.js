// The shopping agent runs as a Cloudflare Pages Function on the same site
// (functions/api/pp/, code in ../worker/), so calls carry the session cookie.
// VITE_AGENT_API points development somewhere else.
import { loadShops } from './stores.js'
import { visitorId } from './visitor.js'

export const AGENT_API = import.meta.env.VITE_AGENT_API ?? '/api/pp'

async function getJson(response) {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(data?.error ?? `The agent answered ${response.status}.`), { code: data?.code, needLogin: data?.needLogin, guest: data?.guest })
  return data
}

// name: a product, searched exactly as typed. details: what they need (the only text the AI reads).
export const askAgent = ({ name, details }, signal) =>
  fetch(`${AGENT_API}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, details, visitor: visitorId() ?? undefined, shops: loadShops() ?? undefined }),
    signal,
  }).then(getJson)

// link: a Daraz or Cartup product page, or the text an app shares with one in it.
export const compareLink = (link, signal) =>
  fetch(`${AGENT_API}/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ link, visitor: visitorId() ?? undefined }),
    signal,
  }).then(getJson)

export const getVouchers = () => fetch(`${AGENT_API}/vouchers`).then(getJson)
export const getStats = () => fetch(`${AGENT_API}/stats`).then(getJson)

export const getAuth = () => fetch(`${AGENT_API}/auth`).then(getJson)
export const sendAuth = (action, fields) =>
  fetch(`${AGENT_API}/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }) }).then(getJson)
export const deleteAccount = (password) =>
  fetch(`${AGENT_API}/auth`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }).then(getJson)

// A guest turning search history off: everything kept under this id is deleted.
export const forgetHistory = (visitor) =>
  fetch(`${AGENT_API}/profiles`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitor }),
  }).then(getJson)
