# DorAI handoff: state on 2026-11-12

A summary for whoever takes the project over. The other docs in this folder
go deeper: `ARCHITECTURE.md` (how it works), `OPERATIONS.md` (running it),
`SCHEMA.md` (database), `API.md` (endpoints), `CHANGELOG.md` (what changed).

## What it is

DorAI is a price-comparison shopping agent for Bangladesh. A shopper types a
product name ("Awei T50") or a need ("bluetooth speaker under 3000"), and DorAI
searches the shops live, works out which listings are the same product, and
shows each shop's best offer side by side, with the price seen last time.

- Live site: https://dorai-bd.pages.dev
- Code: `D:\dorai`, github.com/Atikul-Dipto/dorai (branch `main`)
- Shops:
  - everything: Daraz, Cartup, Othoba
  - electronics: any 3 of Daraz, Cartup, Othoba, Star Tech, Pickaboo (the shopper picks)
- Also:
  - accounts (email and password)
  - 5 free guest searches
  - opt-in search history
  - a watchlist with price-drop alerts (push or Telegram)
  - a browser extension (`extension/`) for comparing from a product page
  - a link-comparison page

## Stack (Cloudflare free plan only, no paid services)

| Part | Where | Notes |
|---|---|---|
| Site and API | Cloudflare Pages project `dorai-bd` | React + Vite front end (`src/`); API as Pages Functions (`functions/api/pp/*`), logic in `worker/` |
| Scheduled jobs | Worker `dorai-jobs` (`jobs/`), cron every 10 min | Watchlist price checks, catalogue matching, backlog re-scoring, daily tidy-up |
| Database | Cloudflare D1 `price-pulse` (binding `PP_DB`) | Migrations `worker/migrations/0001`–`0007`, all applied |
| AI | Workers AI (Llama 3.3 70B) | Only reads what a shopper means (intent); rules take over past the free quota |
| Cache | Cloudflare Cache API | Answers 15 min, comparisons 6 h, Daraz reads 30 min; `CACHE_VERSION` = 22 in `worker/cache.ts` |

Secrets (ADMIN_TOKEN, VAPID keys, RATE_SALT, Telegram) are in Cloudflare and in
the git-ignored `D:\dorai\.dev.vars`. They are not in the repo.

## How a search works (`worker/agent.ts`)

1. Read what the shopper means (`intent.ts`: AI, else rules); pick the shops (`segments.ts`).
2. Each shop read runs as its own request to the site (`worker/parts.ts`,
   `/api/pp/part`). The free plan allows 10 ms CPU per request, and a
   whole search needs about 30 ms, so the work is split across requests.
3. The shops, and how each is read:
   - **Daraz:** its own search JSON, through `worker/polite.ts`:
     - each search cached for 30 min;
     - a 5-min pause after a bot check;
     - while Daraz can't be reached, its last results are shown with their age.
   - **Cartup:** DorAI's own name index in D1, built from Cartup's sitemap,
     plus its category pages, then live product pages (`worker/cartup.ts`).
     Cartup's own search API needs a signed key and isn't used.
   - **Othoba:** its search page first, then an index in D1 (`worker/othoba.ts`).
   - **Star Tech** and **Pickaboo:** their search pages (`startech.ts`, `pickaboo.ts`).
4. Same-product matching, live (`matching.ts`, `ranking.ts`), then
   recommendations per shop (`comparison.ts`).
5. Prices are saved as history (`store.ts`). A listing row is only rewritten
   when it changed or is a day old, to save D1 writes.

## Product catalogue and the same-product model

- `worker/catalog.ts` matches every saved listing to one canonical product.
  The rules give a shortlist; a trained model decides:
  - links at a score of 0.80 or more;
  - makes a new product below 0.20;
  - otherwise sends the pair to manual review at `/review` (needs the admin token).
- **Model:** a logistic regression, `worker/pairModel.ts`, with weights in
  `worker/pairWeights.ts`.
  - Trained by `node scripts/train-matcher.ts` on `data/matching/`: 1,200 real pairs, 1,049 labelled.
  - The labels were made by the AI assistant from titles, not by a person.
  - Measured on pairs it never saw: links 95.9% right (the old rules: 90.4%).
- **Backlog:** links and reviews made before the model are being re-scored by
  the jobs worker, 40 every 10 minutes (`rescoreBacklog`). It started
  2026-11-09 with 5,339 reviews and 5,467 links; it should finish in about 2 days.
- The live search page does **not** use the model yet (it uses `matching.ts` rules).

## Commands (run in `D:\dorai`)

| What | Command |
|---|---|
| Tests (137, all passing) | `npm test` |
| Deploy site + API | `npm run deploy` |
| Deploy jobs worker | `npm run deploy:jobs` |
| Apply DB migrations | `npx wrangler d1 migrations apply price-pulse --remote` |
| Query DB | `npx wrangler d1 execute price-pulse --remote --command "SELECT ..."` |
| Heaviest DB queries | `npx wrangler d1 insights price-pulse --sort-by reads --timePeriod 1d` |
| Retrain matcher | `node scripts/train-matcher.ts` (add `--dry --verbose` to only measure) |

Deploys are manual; pushing to GitHub doesn't deploy.

## Free-plan limits that matter

| Limit | Value | Status |
|---|---|---|
| D1 rows read | 5,000,000 / day, resets at midnight UTC (6 am Bangladesh) | Was exceeded 2026-11-10/11 by a bad query, now fixed; recheck with `d1 insights` |
| D1 rows written | 100,000 / day | About 300 searches/day before the 2026-11-09 fix; now roughly 1,500–2,000/day (estimate) |
| CPU per request | 10 ms | Why shop reads are split into parts |
| Requests | 100,000 / day | Roughly 4–6k searches a day |
| Workers AI | ~10,000 neurons / day | ~700 searches understood by AI, then rules |

## Incidents this week (all fixed and deployed)

1. **2026-11-10/11: every search answered "500" (error 1101).**
   - **Cause:** a query added for the model (founding listing's price) scanned ~11,000 rows per call, so the D1 daily read limit ran out and every query failed.
   - **Fix:** the query now starts from the product ids (`foundersSql` in `catalog.ts`). Guest counting fails open, and `/auth` and `/stats` answer instead of crashing when D1 is down.
2. **Cartup moved off `www`.** `www.cartup.com` now answers 404 to every page; `cartup.com` works. All code now uses `https://cartup.com`, and old `www` links are still recognised.
3. **Cartup said "isn't set up yet" while D1 was down.**
   - Changed to "Couldn't reach Cartup just now", so the answer isn't cached either.
   - Not yet confirmed on the live site (see open issues).

## Open issues and next steps

1. **After the 6 am reset, check Cartup.**
   - Searches should show Cartup products again.
   - During the outage the live site still said "Cartup comparison isn't set up yet", even after the fix. That suggests the D1 binding returns *no row* rather than an error when over the limit. Still unconfirmed.
2. **Cartup sitemaps point at the dead `www` address.** `agent/cartup_index.py` must rewrite `www.cartup.com` to `cartup.com` in sitemap links, or the next index rebuild fails.
3. **Cartup fallback without D1: done for kinds of item.** `worker/cartupSections.ts` (written by `node scripts/cartup-sections.mjs` from Cartup's sitemap) is used when `cartup_meta` can't be read, so "trimmer" or "electric kettle" still browse Cartup. Named products still need the D1 name index. "wireless mouse" now falls back to the "mice" section (last word, exact section name); multi-word kinds with no such section ("face wash") still find nothing.
4. **Nightly index job fails.** GitHub Actions needs two secrets: `CLOUDFLARE_API_TOKEN` (Account → D1 → Edit) and `CLOUDFLARE_ACCOUNT_ID`. Cartup and Othoba name indexes are stale since 2026-11-02.
5. **Monitoring: built (2026-11-15).** `worker/health.ts` runs on its own cron (:05 and :35): one probe per shop plus the database, state in the `health` table, public at `/api/pp/health`. Telegram alerts need the owner's chat id as the jobs secret `ALERT_TELEGRAM_CHAT` (not yet set; see OPERATIONS.md). Without it the checks still run and the endpoint still shows what's down.
6. **Review queue.** Thousands of pairs wait at `/review`. A person's decisions there are the best data to retrain the model with.
7. **CPU of the jobs worker has never been measured** (`wrangler tail dorai-jobs` captured nothing).
8. A test search for "Baseus 20000mAh power bank" showed no pick on Daraz, Star Tech or Pickaboo; not investigated.

## Decisions on record

- **No paid services,** payment methods or paid tiers.
- **Shop access:**
  - no forged or signed store APIs (Daraz mtop, Cartup's signed search, Othoba's hidden search key);
  - no bypassing bot checks;
  - request rates kept polite.

  The owner wants scrapers that rotate IPs and get past blocks. That was not built here. The current code doesn't do it.
- **Visitor data** only with explicit opt-in; the extension never sends an id.
- **Repo rules:** `data/keywords/` stays git-ignored; secrets never go into the repo.

## Gotchas on the developer's Windows PC

- **Git push:** `git push` over HTTPS fails a certificate check. `git -c http.sslBackend=schannel push` works.
- **Wrangler crashes:** `npx wrangler` 4.160.1 crashes on some `d1 execute` commands. Running an older wrangler's `bin/wrangler.js` with `node` works.
- **Command-line quoting:** characters like `>` and `%` in SQL get mangled by the Windows command shell when passed through `npx.cmd`.
- **Time zone:** D1 timestamps are UTC; Bangladesh is UTC+6.
- **Editing scripts:** Python or shell edit scripts turned `\b` in regexes into a backspace character twice. Edit regexes with an editor and scan for control characters afterwards.
