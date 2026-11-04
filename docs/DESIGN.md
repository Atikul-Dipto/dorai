# DorAI design system and page structure

Phase 1 of the redesign (2026-11-03). Decisions taken with the owner:
purple on white (not the logo's green/red), Bangla first with an English
switch, and one big search box with an optional budget/needs line.

## Tokens (`src/index.css`)

| Token | Value | Use |
|---|---|---|
| `--purple` | `#522D60` | headings, strong badges, "same product", savings |
| `--plum` | `#80426E` | primary buttons, links, focus ring, icons |
| `--peach` | `#F2A67B` | Daraz accent, "other size" badge |
| `--gold` | `#FFD38B` | Cartup accent, hero badge, conditional vouchers |
| `--ink` / `--ink-2` / `--muted` / `--faint` | `#2E1A36` / `#4A3150` / `#6F5F77` / `#8C7A90` | text, strongest to weakest |
| `--bg` | `#FFFFFF` | page background (always white) |
| `--tint` / `--tint-2` | `#FAF5F8` / `#F4EAF0` | hero, cards inside cards, skeletons |
| `--line` / `--line-strong` | `#ECE1E8` / `#DCCBD6` | borders |
| `--radius-s` / `--radius` / `--radius-l` | 8 / 14 / 24 px | inputs, cards, hero |

Othoba's accent is `#E3C7DA` (tag) and `#C99BB9` (card top border).

Type: Manrope for Latin, Hind Siliguri for Bangla (one `font-family`
stack, so mixed text picks the right glyphs), DM Mono only for timings.
Bangla text gets a taller line height (`:lang(bn)`), and no uppercase or
letter spacing.

## Components

- Buttons: `.btn` + `.btn-primary` / `.btn-ghost` / `.btn-small` / `.btn-hot`, `.btn-link`, `.icon-btn`.
- Hot deal: `.hot-deal` banner above the stores, `.store-section.is-hot` and `.hot-ribbon` on the winning store, the animated `Flame` icon. Tokens `--hot` `#E4572E`, `--hot-deep` `#B8360F`, `--hot-tint` `#FFF3EA`, used for nothing else. The flame and glow stop under `prefers-reduced-motion`. Wording stays "lowest of the picks": a cheaper row can sit further down a store's list.
- `.chip` (searches), `.badge` (`-strong`, `-warm`), `.store-tag.{daraz,cartup,othoba}`, `.eyebrow`.
- Cards: `.card`, `.how` steps, `.why-grid`, `.store-section` (one per store, side by side; swipe row on phones).
- States: `.progress` with skeleton cards while waiting, `.error-box`, `.empty`.
- `.drawer` (watchlist).

## Page

1. Sticky header: logo, "How it works", Watchlist (count), language switch.
2. Hero: badge, headline, the search (biggest element), "+ Add budget or needs", example/recent chips, live stores and the agent's record.
3. Results right under the search.
4. Popular searches (each a best-fit search for a kind of item), How it works, Why DorAI, the app and extension, public Daraz vouchers, footer.

Page text is in `src/i18n.js` (`STRINGS.bn`, `STRINGS.en`); the language is
remembered in `localStorage` (`dorai:lang`). What the agent writes about an
answer (why a pick, store notes, caveats) is still English from `worker/`.

## Search box behaviour

One box (`name`), plus the optional second line (`details`). The worker
decides how to read the box (`readsAsDescription` in `worker/intent.ts`):
Bangla text, a question, a sentence that opens like a request ("a good…",
"which…", "find me…") or a budget goes to the AI; anything else, and
anything with a model code, is searched exactly as typed. A store link is
compared (`/api/pp/compare`).

## Watchlist (v1)

`src/agent/watchlist.js`: up to 50 products in `localStorage`
(`dorai:watchlist-v1`), each with the price when saved. "Check price now"
calls `/api/pp/compare` for that product and shows the current price and any
cheaper store. No accounts and no server copy yet; alerts come with the
server-side watchlist (see ARCHITECTURE.md).

## Testing and deployment checklist

- [ ] `npm test` (worker unit tests) passes.
- [ ] `npm run build` succeeds; `npx oxlint src` shows no errors.
- [ ] Local preview (`npx vite preview`): home at 1366px and 390px, no horizontal scroll, no console errors.
- [ ] One name search, one description search, one Bangla search, one pasted link: each store shows an offer or an honest note.
- [ ] Save a product, open the watchlist, "Check price now", "Compare on all stores", remove.
- [ ] Switch language; reload keeps it.
- [ ] `npm run deploy`, then repeat one search on https://dorai-bd.pages.dev (a few searches only; Daraz bot-checks bursts).
- [ ] Commit and push.
