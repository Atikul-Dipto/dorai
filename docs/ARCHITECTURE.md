# DorAI architecture

How DorAI is built, box by box, as of 2026-11-03. Everything runs on
Cloudflare's free plan; nothing is paid.

```mermaid
flowchart TB
  user["Customer / Browser / Mobile<br/>web page · installable app (share target) · browser extension"]
  pages["DorAI Frontend<br/>Cloudflare Pages: dorai-bd.pages.dev (src/)"]
  api["API Layer<br/>Pages Functions: functions/api/pp/*"]

  subgraph core["DorAI Core Application (worker/)"]
    orch["Search Orchestrator<br/>agent.ts · compare.ts"]
    ai["AI Query Understanding<br/>intent.ts + Workers AI (Llama 3.3)"]
    match["Product Matching Engine<br/>matching.ts · ranking.ts"]
    price["Price Comparison Engine<br/>comparison.ts · eligibility.ts"]
    watch["Watchlist & Alert Service<br/>watchlist.ts · devices.ts"]
  end

  subgraph collect["Data Collection Layer"]
    jobs["Scheduled Jobs<br/>jobs/ Worker, cron every 10 min"]
    queue["Task Queue<br/>queue.ts (D1 tasks)"]
    adapters["Store Adapters<br/>stores.ts → daraz.ts · cartup.ts · othoba.ts"]
    norm["Data Normalization<br/>normalize.ts"]
    pc["Index builders on the developer's PC<br/>agent/cartup_index.py · othoba_index.py · vouchers"]
  end

  subgraph stores["External Sources"]
    daraz["Daraz"]
    cartup["Cartup"]
    othoba["Othoba"]
  end

  subgraph data["Data Layer"]
    d1["Cloudflare D1 (SQLite)<br/>listings = offers · products · devices = users<br/>watches · alerts · tasks · vouchers · asks · name indexes"]
    history["Price History<br/>D1 price_history"]
    cache["Search & Price Cache<br/>Cache API (cache.ts)"]
  end

  notify["Notification Service<br/>notify.ts: Web Push (VAPID) · Telegram bot"]

  user --> pages --> api
  api --> orch
  api --> watch
  orch --> ai
  orch --> match --> price
  orch --> adapters
  orch --> cache
  orch --> d1
  orch --> history
  jobs --> queue --> adapters
  daraz --> adapters
  cartup --> adapters
  othoba --> adapters
  adapters --> norm
  norm --> history
  norm --> d1
  pc --> d1
  watch --> d1
  watch --> queue
  jobs --> notify
  notify --> user
```

## The boxes

| Box | Where | What it does |
|---|---|---|
| Customer / Browser / Mobile | `src/`, `extension/`, `public/manifest.webmanifest` | The page; the installable app, which takes Android shares from the stores' apps; the Chrome/Edge/Firefox extension on product pages. |
| Frontend | Cloudflare Pages project `dorai-bd` | Static React build (`npm run deploy`). |
| API layer | `functions/api/pp/` | `ask` (search), `compare` (a product link on every store), `vouchers`, `stats`, `device`, `watchlist`, `push`, `alerts`, `telegram-link`, `telegram-webhook`. |
| Search orchestrator | `worker/agent.ts`, `worker/compare.ts` | Runs one request: reads it, searches the stores in parallel, ranks, matches, compares, remembers, answers with per-step timings. |
| AI query understanding | `worker/intent.ts` | Product name vs description (`readsAsDescription`, `namesAProduct`); descriptions, Bangla and budgets go to Workers AI (free 10k neurons/day, rules when it's used up). |
| Product matching engine | `worker/catalog.ts` (catalogue), `worker/matching.ts` + `worker/ranking.ts` (live) | Two halves. The catalogue matches every stored listing to one canonical product, stage by stage (below), in the scheduled jobs. The live half judges same product / other size / close match while an answer is being made, in milliseconds. |
| Price comparison engine | `worker/comparison.ts`, `worker/eligibility.ts` | Each store's recommended offer (trusted sellers, ≥2% real savings, budget), cross-store price facts, public voucher terms. |
| Watchlist & alert service | `worker/watchlist.ts`, `worker/devices.ts` | Server copy of a device's saved products (up to 50), check scheduling, the "worth telling" rule (target price, or ≥5% below the saved price, each drop once). |
| Notification service | `worker/notify.ts` | Web Push with no payload, signed with VAPID (RFC 8292): the service worker fetches the alert text from `/api/pp/alerts`. Telegram bot messages to linked chats. |
| Scheduled jobs | `jobs/index.ts` (Worker `dorai-jobs`) | Every 10 minutes: queue due checks, take 3 off the queue, read current prices through the adapters, record history, alert; then match 50 unprocessed listings to canonical products. |
| Task queue | `worker/queue.ts` | D1 `tasks`: one pending task per product, claim/complete, 3 attempts with back-off, tidy after a week. |
| Store adapters | `worker/stores.ts` + `daraz.ts`, `cartup.ts`, `othoba.ts` | One interface (`find`, `current`) over each store's own way in: Daraz's search JSON; Othoba's search page, read live (server-rendered; its name index is the fallback); Cartup's name index in D1 (its search runs only through a signed API) plus its category pages. Prices always come from product pages or Daraz's search. Daraz products are re-read by search, never their pages. |
| Data normalization | `worker/normalize.ts` | Every listing leaves its adapter in one shape: decoded names, numeric prices, computed discounts, https images. |
| Data layer | D1 `price-pulse`, schema in `worker/migrations/` | Plays the diagram's PostgreSQL role (kept on D1 by choice: free, already holds the data, no extra service). See `docs/SCHEMA.md`. |
| Price history | D1 `price_history` | A point per listing when the price changes or the last point is >6h old; written by every answer and every scheduled check. |
| Search & price cache | `worker/cache.ts` (Cache API) | Comparisons 6 hours, identical searches 15 minutes; never an answer where a store couldn't be reached. |

## The product matching engine (catalogue)

`worker/catalog.ts`, one function per stage. It runs on every listing DorAI
records (answers, compares, price checks), 50 per scheduled run, newest
first; a listing whose name changes goes through again.

```mermaid
flowchart TB
  listing["Store Product Listing<br/>listings row: name, store brand, image, photo id"]
  brand["Extract Brand and Model<br/>extractBrandModel · catalogModel"]
  title["Normalize Product Title<br/>normalizeTitle"]
  specs["Extract Specifications<br/>extractSpecs: size, storage, variant, network, colour, bundle"]
  fp["Generate Product Fingerprint<br/>fingerprint"]
  exists{"Existing Product Match?<br/>candidates: fingerprint · model · photo · brand + words"}
  score["Confidence Score<br/>confidence: 0–1, with reasons"]
  level{"Confidence Level<br/>levelOf"}
  auto["Automatic Match"]
  review["Manual Review<br/>match_reviews · /review"]
  create["Create New Canonical Product<br/>products"]
  link["Link to Existing Product<br/>listings.product_id"]

  listing --> brand --> title --> specs --> fp --> exists
  exists -- "Yes (best ≥ 0.40)" --> score --> level
  exists -- "No" --> create
  level -- "High (≥ 0.80)" --> auto --> link
  level -- "Medium (≥ 0.60) / Low (≥ 0.40)" --> review
  review -- "Same product" --> link
  review -- "Different" --> exists
```

| Stage | Rule |
|---|---|
| Brand | The store's brand field, unless it says "No Brand"; else the title's first word, unless it's a generic word ("Wireless", "Original", "Mobile"…). Accents are dropped ("Nestlé" → nestle). |
| Model | The first real letters-and-digits code ("RB40", "L1504FA", "EQ34"); else a short prefix code ("WH-1000XM5", "HP W10"); else a word with a 2+ digit number ("iPhone 15", "Nokia 215"). Never a spec, multiplier, size, dimension or style ("2.4GHz", "1600DPI", "2x", "3D", "3x3", "Y2K", "Powder 0+"). |
| Normalized title | Lower case, no punctuation, no filler or sales talk, amounts in one unit per kind ("1 Kg" = "1000gm" = 1000g; 1 L = 1000ml). |
| Specifications | Sizes and pack counts, storage (GB), variant words (Pro/Plus/Max…), network (4G/5G), colour (shown, never a conflict), bundle, dimensions ("3x3"), strength ("2x" / "3x" Spicy, a remedy's "3X"), volume ("Vol. 4", "Part 2"). |
| Fingerprint | `m|brand|model|specs` with a model code, `w|brand|all identity words|specs` without. Equal fingerprints with a brand or a model code describe one product; without either ("Bluetooth music receiver") they may be two. |
| Candidates | Products with a listing of the same fingerprint or photo file, the same model code, or the same brand and one of the three longest identity words. Products a person rejected for this listing, or for a listing with the same fingerprint, are left out. |
| Confidence | A different brand, model, size, storage, variant, network, dimensions, strength or volume, or a bundle against a single item, scores 0 (a spec only one title states is no conflict). Otherwise: same brand 0.30 (unknown 0.10), same model 0.50 (code in the other title 0.30), shared identity words up to 0.45 (0.20 with a model), stated size, storage or dimensions agreeing 0.10, identical title of 5+ words 0.25, same photo file 0.45; at most 1. |
| Levels | High ≥ 0.80 links automatically. Medium ≥ 0.60 and low ≥ 0.40 wait for a person at `/review` (admin token); the listing stays unlinked meanwhile. Below 0.40 there's no existing match: a new canonical product. |
| Review | "Same product" links it (`manual`). "Different" remembers the pair and sends the listing through again without that product. One decision covers every pending review of that product for a listing with the same fingerprint (one title copied by five sellers), and later listings with that fingerprint follow it (`manual`, no review). |

Answers don't wait for the catalogue: they match live (`matching.ts`), and
a product's canonical identity is for its history across stores, alerts and,
later, product pages.

## What stays on the developer's PC

Selenium and the big crawls don't fit a Worker's free budget:
`python -m agent --index-cartup` and `--index-othoba` (weekly) rebuild the
name indexes in D1, and `--harvest-vouchers --push-d1` collects Daraz's
public vouchers. See `docs/OPERATIONS.md`.

## Rules the design keeps

- Prices only ever come from the stores, live or as recorded history; nothing is estimated.
- No signed or anti-abuse store APIs (Daraz mtop, Cartup's signed `sxsrf` search, Othoba's hidden search key) and no evading bot checks. Public pages are read at a polite rate: Othoba's search page is read although its robots.txt asks robots not to (the owner's decision, 2026-11-03), one page per question. The scheduled checks are deliberately few per run.
- No accounts and no personal data: a device is a random id; the asks log has no visitor information; rate limits count salted hashes of addresses.
- Free plan only.
