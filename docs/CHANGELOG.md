# Changelog

What changed for shoppers and for the system, newest first. Commit history
has the detail.

## 2026-11-05

- **Hot deal.** The lowest of the stores' picks burns: a banner above the
  stores with an animated flame and a glow, and a ribbon on that store's card.
  It says a saving only on the same product; for a kind of item it says the
  picks are different products. No claim with fewer than two offers, on a tie,
  or when a store couldn't be reached.
- **A kind of item is the thing itself:** a title where the kind word only sits
  in front of another thing ("bench vise", "rice cooker") now ranks lower.
  Cartup's pick for "bench" was a vise, Othoba's a shoe cabinet.

## 2026-11-03

- **Learning events.** The answer page records what shoppers do: opening an
  offer at its store, saving it, and a new "Not what I was looking for" on
  each store's pick (`/api/pp/events`, table `interactions`). No visitor
  information. Nothing uses them in ranking yet.
- **Nightly indexes.** The Cartup and Othoba name indexes rebuild every night
  on GitHub Actions instead of by hand.
- **Docs:** API.md, DATA_COLLECTION.md and this changelog.
- **Search follows the owner's search diagram:** cache → understand → find
  relevant products (DorAI's catalogue alongside the live stores) → rank and
  match → store. A named product's known offers count as the same product, and
  a store live search missed is read again for them. The page says when an
  answer came from the cache.
- **A model code is never inside a longer number:** "Awei T50" made a T500
  treadmill Daraz's pick.
- **Product matching engine** (the owner's flowchart): every listing is
  matched to one canonical product: brand and model, normalized title,
  specs, fingerprint, confidence; high links automatically, medium and low go
  to the owner's review page `/review`. Tuned on live batches: 1 kg = 1000 gm;
  brand + model is confident; GHz, 3x3 and Y2K are no model codes; 2x / 3x,
  volume numbers and dimensions are conflicts; one review decision covers a
  title copied by several sellers.
- **Othoba is searched live**, like Daraz; its full catalogue (70,642
  products) is indexed behind it. Cartup's sitemaps refresh daily.
- **Architecture built** from the owner's diagram: matching and comparison
  engines, store adapters, normalization, D1 data layer, caches, scheduled
  jobs, watchlist alerts by Web Push and Telegram.
- **Redesign, phase 1:** design system, Bangla-first home with an English
  switch, one search box, watchlist with target prices.
- Matching: an unbranded listing copied word for word is the same product;
  another brand of the same kind never is; "A4tech" is a brand, not a model.

## 2026-11-02

- **DorAI** is the new name; its own repository and site, dorai-bd.pages.dev.
- **Othoba** is the third store; every store answers side by side.
- Browser extension (Chrome, Edge, Firefox) and an installable app that takes
  shares from the stores' apps.
- No "best price" claim when a store couldn't be checked; unbranded products
  matched by their photo; Cartup's menu sections ("mobile" finds its phones);
  casings and accessories never stand in for the product.
- The দরAI logo and the purple-on-white palette.

## 2026-10-21 – 10-29 (as Price Pulse)

- A shopping agent for Daraz, live on Cloudflare: live search, the last price
  seen, voucher checks; a named product comes first.
- Cartup compared on every answer, through its sitemap and product pages;
  the stores as equals, each answering for itself; Cartup's hidden ratings
  ignored.
- Matching: every "More" row matches the product; bundles never match a
  single size; renamed Cartup listings found.

## 2026-08-27 – 09-20 (the first Price Pulse)

- A Selenium price-tracking pipeline over several Bangladeshi stores, a
  dashboard, a Postgres + FastAPI backend, trend stats. Retired from the page
  when the agent replaced it; the code is still in `scraper/` and `backend/`.
