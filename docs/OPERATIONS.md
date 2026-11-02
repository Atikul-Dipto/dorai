# Running DorAI

Everything is deployed by hand from `D:\dorai` (not on git push).

## Deploy

| What | Command | Notes |
|---|---|---|
| Site + API (Pages `dorai-bd`) | `npm run deploy` | Builds the page, uploads it with `functions/`. |
| Scheduled jobs (Worker `dorai-jobs`) | `npm run deploy:jobs` | Cron `*/10 * * * *`, no public URL. Needs the account's workers.dev subdomain (`atikul-dipto`, created 2026-11-03). |
| Database changes | `npx wrangler d1 migrations apply price-pulse --remote` | Migrations in `worker/migrations/`. |
| Tests | `npm test` | Offline; the services test runs on node:sqlite with the migrations applied. |

After a deploy, check with one or two searches only: Daraz bot-checks bursts
from Cloudflare.

## Secrets and settings

Local copies live in `.dev.vars` (gitignored). Set a secret with
`npx wrangler pages secret put NAME --project-name dorai-bd` (site) or
`npx wrangler secret put NAME --config jobs/wrangler.toml` (jobs).

| Name | Where | What |
|---|---|---|
| `ADMIN_TOKEN` | site | Unlocks the recent-questions list in `/api/pp/stats`. |
| `VAPID_PUBLIC_KEY` | site + jobs, as a plain setting in each `wrangler.toml` | Push key, public half. |
| `VAPID_PRIVATE_JWK` | site + jobs, secret | Push key, private half (JWK). Changing the key pair turns every device's notifications off until it re-subscribes. |
| `RATE_SALT` | site, secret | Salt for the hashed caller keys the rate limits count. |
| `TELEGRAM_BOT_TOKEN` | site + jobs, secret | From BotFather. Telegram stays off until set. |
| `TELEGRAM_BOT_NAME` | site, plain setting in `wrangler.toml` | The bot's username, without @. |
| `TELEGRAM_WEBHOOK_SECRET` | site, secret | Any random string; Telegram sends it back on every webhook call. |

## Turning on Telegram alerts

1. In Telegram, message **@BotFather**, send `/newbot`, pick a name and a
   username ending in `bot` (e.g. `DorAIAlertsBot`). It replies with a token.
2. Give the token and the username to Claude, or do the rest yourself:
   - add `TELEGRAM_BOT_NAME = "<username>"` under `[vars]` in `wrangler.toml`;
   - set `TELEGRAM_BOT_TOKEN` on the site and on jobs, and a random `TELEGRAM_WEBHOOK_SECRET` on the site;
   - point the bot at the webhook:
     `https://api.telegram.org/bot<token>/setWebhook?url=https://dorai-bd.pages.dev/api/pp/telegram-webhook&secret_token=<secret>`;
   - `npm run deploy` and `npm run deploy:jobs`.
3. In the watchlist, "Connect Telegram" now appears.

## Reviewing product matches

Open https://dorai-bd.pages.dev/review and enter the `ADMIN_TOKEN` (in
`.dev.vars`; kept in that browser only). Each card is a listing the
matching engine scored 0.40–0.79 against its best candidate product, with
the reasons. "Same product" links it; "Different" sends it through the
engine again without that product. The page's top line shows how the
catalogue stands (matched automatically, by you, new products, waiting).

## Weekly upkeep (on this PC)

```powershell
.venv\Scripts\python.exe -m agent --index-cartup     # Cartup name index + its menu
.venv\Scripts\python.exe -m agent --index-othoba     # Othoba name index (~20 min)
.venv\Scripts\python.exe -m agent --harvest-vouchers --push-d1   # around sales
```

## Looking into things

```powershell
# Real questions and how they went
npx wrangler d1 execute price-pulse --remote --command "SELECT asked_at, query, mode, total_ms, error FROM asks ORDER BY id DESC LIMIT 20"
# The task queue and the last scheduled checks
npx wrangler d1 execute price-pulse --remote --command "SELECT kind, key, status, attempts, last_error, updated_at FROM tasks ORDER BY id DESC LIMIT 20"
# Alerts sent
npx wrangler d1 execute price-pulse --remote --command "SELECT created_at, name, old_price, new_price, push_status, telegram_status FROM alerts ORDER BY id DESC LIMIT 20"
# The jobs Worker's own log, live
npx wrangler tail dorai-jobs
```
