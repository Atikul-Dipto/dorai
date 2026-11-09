# D1 schema (`price-pulse`)

Migrations: `worker/migrations/0001_init.sql`, `0002_architecture.sql`, `0003_matching_engine.sql`, `0004_interactions.sql`, `0005_visitor_profiles.sql`, `0006_accounts.sql`.

| Table | Role in the architecture | Rows written by |
|---|---|---|
| `listings` | **Offers**: one per store item (Daraz item, Cartup or Othoba page): name, store brand, image, photo id, and from the matching engine its fingerprint, `product_id`, `match_status` (NULL until processed · `new` · `auto` · `review` · `manual`) and `match_score` | every answer, compare, scheduled check; matching engine |
| `products` | **Canonical products**: name, brand, model, identity words, fingerprint, photo, specs | matching engine (`catalog.ts`) |
| `match_reviews` | **Manual review** queue: a listing, its best candidate product, the score, level and reasons; pending · approved · rejected | matching engine, `/api/pp/review` |
| `price_history` | **Price history**: a point when the price changes or the last is >6h old | every answer, compare, scheduled check; `tools/keyword-batch.ts push` |
| `users` | **Accounts**: email, PBKDF2 password hash, its salt and rounds, recovery code hash, whether search history is on | `/api/pp/auth` |
| `sessions` | A signed-in browser: hash of the cookie's token, its user, when it expires (90 days) | `/api/pp/auth`, scheduled jobs |
| `guests` | The guest trial: a salted hash of the cookie and how many free searches it has used | `/api/pp/ask`, `/compare`, scheduled jobs |
| `devices` | **Alert devices**, anonymous: random id, hashed secret, language, push endpoint, Telegram chat | `/api/pp/device`, `/push`, Telegram webhook |
| `watches` | A device's watchlist: saved price, optional target, last checked price, last alerted price | `/api/pp/watchlist`, scheduled checks |
| `alerts` | Price-drop alerts sent, and each channel's outcome | scheduled jobs, `/api/pp/push` (test) |
| `telegram_links` | One-time codes linking a device to a Telegram chat (a day at most) | `/api/pp/telegram-link`, webhook |
| `tasks` | **Task queue**: `check_price` per watched product | watchlist service, scheduled jobs |
| `rate_limits` | Fixed-window counters for write endpoints, by salted hash | `/api/pp/device`, `/watchlist`, `/push`, `/events`, `/profiles`, `/auth`, guest searches |
| `vouchers` | Public Daraz vouchers | voucher harvester on the PC |
| `asks` | Each question's outcome and timings. `visitor`: only for a shopper who said yes to search history: `u<id>` for an account, a salted hash for a guest | `/api/pp/ask`, `/compare` |
| `interactions` | **Learning events**: what shoppers did with an answer (open · save · unsave · not_this), on which offer, pick or "More" row, its relation and position, the price shown, the canonical product then. `visitor` as in `asks` | `/api/pp/events` |
| `cartup_docs`, `cartup_postings`, `cartup_meta` | Cartup name index (sharded, compressed) and its menu | `python -m agent --index-cartup` (nightly on GitHub Actions) |
| `othoba_docs`, `othoba_postings`, `othoba_meta` | Othoba name index | `python -m agent --index-othoba` (nightly on GitHub Actions) |

Key relationships: `listings.product_id → products.id`;
`watches.device_id`, `alerts.device_id`, `telegram_links.device_id →
devices.id` (deleted with the device); `sessions.user_id → users.id`; `price_history.item_id`,
`watches.item_id`, `tasks.key → listings.item_id` (by value).

D1's free plan: 500 MB per database, 5 GB per account, 5M rows read and 100k
rows written a day. The database is ~146 MB (2026-11-05), mostly the two name
indexes; a Cartup rebuild briefly holds a second copy of its index.

Writes are the limit that bites first. Every row counts, and so does every index
entry it changes. Before 2026-11-09 a search re-saved each of its ~57 listings
(about 250 rows, ~300 searches a day). Now a listing is written only when it is
new, renamed, gains a brand or photo it lacked, or was last written over a day
ago (`LISTING_REFRESH_HOURS`); a price point only when the price changed or the
last one is over 6 hours old.
