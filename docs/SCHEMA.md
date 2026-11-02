# D1 schema (`price-pulse`)

Migrations: `worker/migrations/0001_init.sql`, `0002_architecture.sql`.

| Table | Role in the architecture | Rows written by |
|---|---|---|
| `listings` | **Offers**: one per store item (Daraz item, Cartup or Othoba page), with `product_id` once matched | every answer, compare, scheduled check |
| `products` | **Products**: offers the matching engine found to be the same thing, across stores | named searches and compares (`store.linkProduct`) |
| `price_history` | **Price history**: a point when the price changes or the last is >6h old | every answer, compare, scheduled check; `tools/keyword-batch.ts push` |
| `devices` | **Users**, anonymous: random id, hashed secret, language, push endpoint, Telegram chat | `/api/pp/device`, `/push`, Telegram webhook |
| `watches` | A device's watchlist: saved price, optional target, last checked price, last alerted price | `/api/pp/watchlist`, scheduled checks |
| `alerts` | Price-drop alerts sent, and each channel's outcome | scheduled jobs, `/api/pp/push` (test) |
| `telegram_links` | One-time codes linking a device to a Telegram chat (a day at most) | `/api/pp/telegram-link`, webhook |
| `tasks` | **Task queue**: `check_price` per watched product | watchlist service, scheduled jobs |
| `rate_limits` | Fixed-window counters for write endpoints, by salted hash | `/api/pp/device`, `/watchlist`, `/push` |
| `vouchers` | Public Daraz vouchers | voucher harvester on the PC |
| `asks` | Each question's outcome and timings (no visitor data) | `/api/pp/ask`, `/compare` |
| `cartup_docs`, `cartup_postings`, `cartup_meta` | Cartup name index (sharded, compressed) and its menu | `python -m agent --index-cartup` |
| `othoba_docs`, `othoba_postings`, `othoba_meta` | Othoba name index | `python -m agent --index-othoba` |

Key relationships: `listings.product_id → products.id`;
`watches.device_id`, `alerts.device_id`, `telegram_links.device_id →
devices.id` (deleted with the device); `price_history.item_id`,
`watches.item_id`, `tasks.key → listings.item_id` (by value).

D1's free plan: 5 GB storage, 5M rows read and 100k rows written a day. The
database is ~120 MB, mostly the two name indexes.
