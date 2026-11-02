/** Response helpers shared by the DorAI endpoints in functions/api/pp/. */

// DorAI's own site (and its preview deployments), plus local dev.
const ALLOWED = [/^https:\/\/([a-z0-9-]+\.)?dorai-bd\.pages\.dev$/, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/]

export function cors(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  if (!ALLOWED.some((re) => re.test(origin))) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

export const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors(request) },
  })

export const preflight = ({ request }: { request: Request }) => new Response(null, { status: 204, headers: cors(request) })
