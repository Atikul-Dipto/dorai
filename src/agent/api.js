// The shopping agent runs as a Cloudflare Pages Function on the same site
// (functions/api/pp/, code in ../worker/). VITE_AGENT_API points development
// at a preview deployment instead.
export const AGENT_API = import.meta.env.VITE_AGENT_API ?? 'https://dorai-bd.pages.dev/api/pp'

async function getJson(response) {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error ?? `The agent answered ${response.status}.`)
  return data
}

// name: a product, searched exactly as typed. details: what they need (the only text the AI reads).
export const askAgent = ({ name, details }, signal) =>
  fetch(`${AGENT_API}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, details }),
    signal,
  }).then(getJson)

// link: a Daraz or Cartup product page, or the text an app shares with one in it.
export const compareLink = (link, signal) => fetch(`${AGENT_API}/compare?link=${encodeURIComponent(link)}`, { signal }).then(getJson)

export const getVouchers = () => fetch(`${AGENT_API}/vouchers`).then(getJson)
export const getStats = () => fetch(`${AGENT_API}/stats`).then(getJson)
