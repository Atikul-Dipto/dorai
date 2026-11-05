# DorAI API

Every endpoint is a Cloudflare Pages Function under
`https://dorai-bd.pages.dev/api/pp/` (code in `functions/api/pp/`, the work
in `worker/`). Answers are JSON. Browsers may call it only from DorAI's own
site, its preview deployments and localhost (CORS, `worker/http.ts`).

Three kinds of access:

| Access | How |
|---|---|
| Public | Nothing to send. |
| Device | `Authorization: Bearer <token>` from `POST /device` (an anonymous device; only a hash of the secret is stored). |
| Owner | `Authorization: Bearer <ADMIN_TOKEN>` (a Pages secret; the local copy is in `.dev.vars`). |

## Search and compare

### `POST /ask` · `GET /ask` — public

A shopper's question, answered across the stores (`worker/agent.ts`).

| Field | Meaning |
|---|---|
| `query` (or `?q=`) | One box: a product name, a description, a question, in Bangla or English. |
| `name` + `details` (or `?name=&details=`) | Two boxes: the product as typed, and what they need (budget, features). Either may be empty, not both. |

Answer (`Answer` in `worker/agent.ts`): `query`, `intent` (mode, kind,
brand, budget, attributes), `stores[]` (one section per store: `recommended`
with price, voucher and price memory, `why`, `matches[]` with `relation`
same / variant / close / fits, `note`, `link`), `summary`, `hotDeal` (the lowest of the stores' picks: `site`, `name`, `url`, `price`, `voucher`, `sameProduct`, `rival`, `saving`, `stores`; null when there's no true claim to make), `catalogue` (the
canonical product a named product is, and the offers it vouched for),
`checkedAt`, `timingsMs`, `cached`.

The same search within 15 minutes is answered from the cache; an answer
where a store couldn't be reached isn't cached. Errors: 400 (nothing or too
much typed), 502 (the search failed).

### `GET /compare?link=&name=` · `POST /compare` — public

One product a shopper is looking at (a Daraz, Cartup or Othoba link, or the
text a store's app shares), on every store (`worker/compare.ts`): `source`,
`stores[]`, `cheaper`, `hotDeal`, `unreachable[]`, `checkedAt`, `cached`. Cached 6
hours per product. Used by the browser extension and the installable app.

### `GET /vouchers` — public

The public Daraz vouchers DorAI knows, and when they were collected.

### `GET /stats` — public totals; owner for recent questions

How the agent is doing: questions answered, timings, outcomes. The list of
recent questions needs the owner token.

## Learning events

### `POST /events` — public, 300 an hour per caller

What a shopper did with an answer (`worker/interactions.ts`). The page sends
them as a beacon (`text/plain`). `visitor` is added only for a shopper who said
yes to search history (see Visitor profiles).

```json
{ "events": [{ "kind": "open", "query": "Awei T50", "itemId": "562252743", "site": "daraz", "slot": "pick", "price": 1150 }] }
```

| Field | Values |
|---|---|
| `kind` | `open` (went to the store) · `save` · `unsave` · `not_this` |
| `slot` | `pick` (a store's recommended option) · `match` (a "More" row) |
| `relation`, `position` | For a match: `same` / `variant` / `close` / `fits`, and its row (1 = first) |

Up to 10 per call. Answer: `{ recorded }`.

### `GET /events?days=7` — owner

The readout: counts per kind, opens by slot and relation, most opened
offers, and the picks most often called not what was wanted.

## Visitor profiles

What one shopper searches and looks up (`worker/profiles.ts`; the page is
`/profiles`), only for those who said yes on the site. `POST /ask`,
`POST /compare` and `POST /events` then send `visitor`, the 32-character hex id
in that browser; the database keeps a salted hash of it. Anything else in
`visitor` is ignored, and the row is logged with no visitor.

| Endpoint | Access | What |
|---|---|---|
| `GET /profiles` | owner | Everyone with a history: 100, most recently active first. |
| `GET /profiles?id=<key>` | owner | One visitor's pattern (searches, repeats, stores, brands, prices, time of day, products) and last 100 acts. |
| `DELETE /profiles` | public, 30 an hour per caller | `{ visitor }`: delete everything kept under that id. |

## Price-drop alerts

| Endpoint | Access | What |
|---|---|---|
| `POST /device` | public, 5 an hour per caller | A new anonymous device: `{ deviceId, token, vapidPublicKey, telegram }`. |
| `GET /device` | device | Its alert channels. |
| `DELETE /device` | device | Forget it, its watchlist and alerts. |
| `GET /watchlist` | device | Its saved products. |
| `PUT /watchlist` | device, 200 changes an hour | `{ watches: [{ itemId, site, name, url, image?, savedPrice, targetPrice? }] }`, up to 50 products. |
| `DELETE /watchlist?itemId=` | device | Stop watching one. |
| `PUT /push` | device | Save the browser's push endpoint `{ endpoint }` (pushes carry no payload). |
| `POST /push` | device, 5 an hour | A test notification. |
| `DELETE /push` | device | Stop push alerts. |
| `GET /alerts` | device | Alerts not shown yet (then marked shown); `?all=1` for the last 20. Called by the service worker when a push arrives. |
| `POST /telegram-link` | device | A one-time `t.me` link to connect the Telegram bot. |
| `DELETE /telegram-link` | device | Stop Telegram alerts. |
| `POST /telegram-webhook` | Telegram, with the shared secret header | `/start <code>`, `/stop`. |

## The catalogue

### `GET /review` · `POST /review` — owner

The matching engine's manual review (`worker/catalog.ts`; the page is
`/review`). GET: the catalogue's counts and the oldest pending reviews.
POST `{ id, decision: "same" | "different" }`: decides it, and the pending
reviews of the same title from other sellers. Answer: `{ decided }` (how
many).
