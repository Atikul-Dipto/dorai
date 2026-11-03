# How DorAI collects store data

What DorAI reads from each store, how, how often, and the lines it keeps.
Prices are only ever what a store shows: read live when a shopper asks, or
recorded from such a read. Nothing is estimated.

## What is read, per store

| Store | When a shopper asks (live) | Collected ahead of time | Why this way |
|---|---|---|---|
| **Daraz** | Its search JSON (`/catalog/?ajax=true&q=`): the typed name, its brand + model code, near the budget; a category search when the first is noise. Up to ~6 searches per question. | Nothing. Public vouchers from campaign pages, by `--harvest-vouchers` on the PC. | Daraz's search covers its whole catalogue and returns prices, sellers and ratings in ~0.6 s. Its product pages bot-check sooner, so a Daraz product is re-read through search, never its page. |
| **Othoba** | Its search page (`/search?q=`, server-rendered), then up to 4 product pages (schema.org Product data) for prices. | A name index of every product (`--index-othoba`): category pages in menu order, one page a second. 70,642 products on 2026-11-03. | The index is the fallback when Othoba's search finds nothing. |
| **Cartup** | Our name index, then up to 4 product pages (schema.org data, the visible reviews). Category and menu pages for a kind of item. | A name index of every product from its product sitemaps (`--index-cartup`, 899,150 products on 2026-11-02), and its menu sections (`--cartup-menu`, a browser). | Cartup's own search runs only through a signed API, which DorAI doesn't forge. |

Each answer records the prices it read (`price_history`: a new point when
the price changes or the last is over 6 hours old) and the listings it saw,
which the matching engine then puts in the catalogue (`docs/ARCHITECTURE.md`).

## Schedules

| What | Where | How often |
|---|---|---|
| Cartup and Othoba name indexes | GitHub Actions, `.github/workflows/nightly-indexes.yml` | Every night at 02:00 Dhaka (Cartup, then Othoba). Can also be run by hand, or as a dry run. |
| Watched products' prices | Worker `dorai-jobs` | Every 10 minutes, 3 products per run, each at most every 6 hours. |
| Matching listings to canonical products | Worker `dorai-jobs` | Every 10 minutes, 50 listings per run. No store is contacted. |
| Daraz vouchers | This PC: `python -m agent --harvest-vouchers --push-d1` | By hand, around sales. |

A crawl replaces an index whole: it's built in `*_new` tables and swapped in
at the end, so a failed run leaves the last good index in place. GitHub
pauses scheduled workflows in a repository with no commits for 60 days.

## The lines kept

- **Polite rates:** Othoba's crawl reads one page a second; Cartup's sitemaps
  are fetched one file at a time; a question reads at most 4 product pages
  per store; the scheduled checks take 3 products per run.
- **No forged or anti-abuse APIs:** not Daraz's signed mtop API, not Cartup's
  signed `sxsrf` search, not Othoba's hidden search key.
- **No getting past bot checks:** a store that answers with a challenge isn't
  read (Ryans sits behind Cloudflare's bot challenge, so it isn't a store
  here). When Daraz bot-checks, the answer says Daraz couldn't be reached.
- **robots.txt** is not followed for Othoba's search page and Cartup's
  category pages (the owner's decision, 2026-11-03); every other line above
  still holds.
- **No visitor data:** questions are logged without who asked; learning
  events hold the search, the offer and the act only; rate limits count
  salted hashes of addresses.
