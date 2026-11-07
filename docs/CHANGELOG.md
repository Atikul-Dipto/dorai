# Changelog

What changed for shoppers and for the system, newest first. Commit history
has the detail.

## 2026-11-07

- **Star Tech and Pickaboo**, two electronics retailers, join as shops. A search
  compares three shops: Daraz, Cartup and Othoba for most things; for
  electronics, Daraz, Star Tech and Pickaboo unless the shopper picks another
  three of the five. Their own stock counts as a trusted seller ("Sold by Star
  Tech"). Saved products from them are checked like any other.
- **Links no longer dead-end.** A Daraz link its search doesn't list is read from
  its own page. A listing that's gone (Cartup's "temporarily unavailable", a
  Daraz 404) now says so, and from the site its name is searched on all three
  stores instead. It used to say the page couldn't be read, and stop.
- **Guests always see what they named.** A row with exactly the name they
  searched for is kept, wherever it ranks.
- **Search no longer dies when it's busy.** A search used about 30 ms of CPU
  against the free plan's 10 ms a request. Cloudflare tolerates that now and
  then, then kills requests (error 1102) until the deployment is replaced, and
  search was down that way on 2026-11-06. Each store read now runs as a request
  of its own.
- **Alerts in Brave.** Brave keeps Google's push service off by default, so it
  refuses every push subscription. The watchlist now says which setting to turn
  on, instead of showing the browser's own error.
- **Accounts and a guest trial.** Shoppers can create an account with an email
  and password. A guest gets 5 searches, and each store shows its pick and 2
  more rows; an account searches freely and sees every row. A search that fails
  or finds nothing isn't counted, and going back to an answer on the page isn't
  a new search. All of it is decided on the server. The extension is unchanged.
- **Passwords** can be reset with a recovery code shown once at sign-up, because
  DorAI can't send email yet. Addresses aren't verified, for the same reason.
- **Search history** stays a separate yes. With an account it follows the
  person across devices and shows by email at `/profiles`, and a guest's history
  joins their account. Deleting an account deletes its history.

## 2026-11-06

- **Visitor profiles.** A shopper can say yes to search history. Their searches,
  opened offers and saves are then linked by a salted hash of a random id in
  their browser, and the owner reads the pattern at `/profiles`. Nothing is
  linked without that yes, no name or address is kept, turning it off deletes
  the history, and the link goes after a year. The extension sends no id.

## 2026-11-05

- **New English type:** Poppins Bold for headings and prices, Gill Sans for
  text (Cabin where a device doesn't have it). Bangla stays Hind Siliguri until
  FontBD allows its fonts on the site (`docs/DESIGN.md`).
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
