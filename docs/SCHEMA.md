# D1 schema (`price-pulse`)

Migrations: `worker/migrations/0001_init.sql`, `0002_architecture.sql`, `0003_matching_engine.sql`.

| Table | Role in the architecture | Rows written by |
|---|---|---|
| `listings` | **Offers**: one per store item (Daraz item, Cartup or Othoba page): name, store brand, image, photo id, and from the matching engine its fingerprint, `product_id`, `match_status` (NULL until processed · `new` · `auto` · `review` · `manual`) and `match_score` | every answer, compare, scheduled check; matching engine |
| `products` | **Canonical products**: name, brand, model, identity words, fingerprint, photo, specs | matching engine (`catalog.ts`) |
| `match_reviews` | **Manual review** queue: a listing, its best candidate product, the score, level and reasons; pending · approved · rejected | matching engine, `/api/pp/review` |
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
