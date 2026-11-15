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
| `RATE_SALT` | site, secret | Salt for the hashed caller keys the rate limits count and for visitor keys. Changing it splits every guest's history in two, and their "delete" no longer reaches the old half; it also gives every guest a new trial. |
| `TELEGRAM_BOT_TOKEN` | site + jobs, secret | From BotFather. Telegram stays off until set. |
| `TELEGRAM_BOT_NAME` | site, plain setting in `wrangler.toml` | The bot's username, without @. |
| `TELEGRAM_WEBHOOK_SECRET` | site, secret | Any random string; Telegram sends it back on every webhook call. |
| `ALERT_TELEGRAM_CHAT` | jobs, secret | The owner's Telegram chat id. The self-checks (`worker/health.ts`, twice an hour) send "X has been failing since…" and "X is back" there. Get the id by messaging `@userinfobot` on Telegram, then `npx wrangler secret put ALERT_TELEGRAM_CHAT --config jobs/wrangler.toml`. Without it the checks still run and show at `/api/pp/health`. |

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

Search history is read at https://dorai-bd.pages.dev/profiles with the same
token: accounts by email, guests by a short id.

Open https://dorai-bd.pages.dev/review and enter the `ADMIN_TOKEN` (in
`.dev.vars`; kept in that browser only). Each card is a listing the
matching engine scored 0.40–0.79 against its best candidate product, with
the reasons. "Same product" links it; "Different" sends it through the
engine again without that product. A decision also settles the cards of the
same title from other sellers (the page reloads), and that title arriving
later follows it. The page's top line shows how the catalogue stands
(matched automatically, by you, new products, waiting).

## Nightly indexes (GitHub Actions)

`.github/workflows/nightly-indexes.yml` rebuilds the Cartup and Othoba name
indexes at 02:00 Dhaka every night (docs/DATA_COLLECTION.md). It needs two
repository secrets (GitHub → the `dorai` repo → Settings → Secrets and
variables → Actions):

| Secret | What |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account's id (`npx wrangler whoami`). |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → Custom token: permission **Account · D1 · Edit**, account resources: this account. Nothing else. |

Run it by hand from the repo's Actions tab ("Run workflow": both stores or
one, optionally a dry run that uploads nothing) or with
`gh workflow run nightly-indexes.yml -f stores=cartup -f dry_run=true`.
A failed night leaves the last good index in place.

## By hand (on this PC)

```powershell
.venv\Scripts\python.exe -m agent --index-cartup     # Cartup name index (also nightly on GitHub)
.venv\Scripts\python.exe -m agent --cartup-menu      # Cartup's menu sections (also nightly)
.venv\Scripts\python.exe -m agent --index-othoba     # Othoba name index, ~2 hours (also nightly)
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
# Learning events, summed up (last 7 days; ADMIN_TOKEN from .dev.vars)
curl -H "authorization: Bearer $ADMIN_TOKEN" "https://dorai-bd.pages.dev/api/pp/events?days=7"
# ...or raw
npx wrangler d1 execute price-pulse --remote --command "SELECT at, kind, query, site, slot, relation, position, price FROM interactions ORDER BY id DESC LIMIT 30"
```
