import { useCallback, useEffect, useRef, useState } from 'react'
import { useLang } from '../i18n.js'
import { useAccount } from './account.js'
import { askAgent, compareLink } from './api.js'
import { track } from './events.js'
import { money } from './format.js'
import { ALL_SHOPS, saveShops, SHOPS_PER_SEARCH, STORE_LABEL, STORE_LINK } from './stores.js'
import { useWatchlist } from './watchlist.js'

// One big box: a product name (searched exactly as typed — long, specific
// titles are what the AI misreads), a description or a question (read by the
// AI; worker/intent.ts readsAsDescription decides), or a store link. The
// optional second line is budget and needs, the only other text the AI reads.
const EXAMPLES = [
  { name: 'Samsung Galaxy A36' },
  { name: 'A good wireless mouse for office work' },
  { name: 'ভালো ব্যাটারি সহ ১৫০০০ টাকার মধ্যে ফোন' },
  { name: 'monitor', details: '30k' },
]
const RECENT_KEY = 'pricepulse:recent-asks-v2'
const KEEP_ANSWER_MS = 15 * 60 * 1000 // as long as the server's own cache
const askKey = (ask) => JSON.stringify([ask.name.trim(), ask.details.trim()])

// The order the agent works in (worker/agent.ts). While waiting, the current
// step is estimated from typical timings; once the answer lands, the real
// per-step timings replace the estimate.
const STEPS = [
  { key: 'understand', short: 'read', typicalMs: 1500 },
  { key: 'search', short: 'search', typicalMs: 600 },
  { key: 'remember', short: 'memory', typicalMs: 250 },
  { key: 'check', short: 'vouchers', typicalMs: 50 },
]

const locale = (lang) => (lang === 'bn' ? 'bn-BD' : 'en-GB')
const shortDate = (iso, lang) => new Date(iso).toLocaleDateString(locale(lang), { day: 'numeric', month: 'short' })
const clock = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : [], { hour: '2-digit', minute: '2-digit' })
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`
const tidy = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const label = (ask) => [ask.name, ask.details].filter(Boolean).join(' — ') || ask.query || ''
const sameAsk = (a, b) => tidy(a.name).toLowerCase() === tidy(b.name).toLowerCase() && tidy(a.details).toLowerCase() === tidy(b.details).toLowerCase()
// Roughly what the agent will hand to the AI (the real rule is worker/intent.ts), for the progress list only.
const readsText = (ask) => Boolean(ask.details) || /[ঀ-৿?]/.test(ask.name) || ask.name.split(' ').length > 4

function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((a) => a && (typeof a.name === 'string' || typeof a.details === 'string')).slice(0, 6) : []
  } catch {
    return []
  }
}

function saveRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // Storage blocked: recent searches just aren't remembered.
  }
}

/**
 * ?name=&details= (shareable answers); ?q= from older links is read as a
 * product name. ?link= is a product to compare (from the browser extension),
 * and ?url=/?text= is what Android's Share sends when DorAI is installed.
 */
function askFromUrl() {
  const p = new URLSearchParams(window.location.search)
  const shared = p.get('link') ?? [p.get('url'), p.get('text')].filter(Boolean).join(' ')
  if (shared) return { name: shared, details: '' }
  return { name: p.get('name') ?? p.get('q') ?? '', details: p.get('details') ?? '' }
}

function setUrlAsk(ask) {
  const url = new URL(window.location.href)
  for (const key of ['q', 'name', 'details', 'link', 'url', 'text', 'title']) url.searchParams.delete(key)
  if (STORE_LINK.test(ask.name)) url.searchParams.set('link', ask.name)
  else {
    if (ask.name) url.searchParams.set('name', ask.name)
    if (ask.details) url.searchParams.set('details', ask.details)
  }
  url.hash = ''
  window.history.pushState(ask, '', url)
}

function Progress({ elapsed, readsDetails }) {
  const { t } = useLang()
  // With nothing for the AI to read, that step is skipped.
  const steps = readsDetails ? STEPS : STEPS.slice(1)
  const ends = steps.map((_, i) => steps.slice(0, i + 1).reduce((sum, s) => sum + s.typicalMs, 0))
  const current = ends.findIndex((end) => elapsed < end)
  const active = current === -1 ? steps.length - 1 : current
  return (
    <div className="progress" role="status" aria-live="polite">
      <ol>
        {steps.map((step, index) => (
          <li key={step.key} className={index < active ? 'done' : index === active ? 'active' : ''}>
            <i aria-hidden="true" />
            {t.steps[step.key]}
          </li>
        ))}
      </ol>
      <span className="progress-timer">{seconds(elapsed)}</span>
      <div className="skeleton-row" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton-card">
            <i />
            <b />
            <b />
          </div>
        ))}
      </div>
    </div>
  )
}

function Understood({ intent }) {
  const { t } = useLang()
  const named = intent.mode === 'product'
  const wishes = []
  if (!named && intent.productType) wishes.push(intent.productType)
  if (intent.brand && !named) wishes.push(intent.brand)
  if (intent.minPrice && intent.maxPrice) wishes.push(`${money(intent.minPrice)}–${money(intent.maxPrice)}`)
  else if (intent.maxPrice) wishes.push(`≤ ${money(intent.maxPrice)}`)
  else if (intent.minPrice) wishes.push(`≥ ${money(intent.minPrice)}`)
  return (
    <p className="understood">
      <span>{named ? t.understoodName : t.understoodNeed}</span>
      {named && <b>“{intent.searchQuery}”</b>}
      {wishes.map((p) => (
        <b key={p}>{p}</b>
      ))}
      {intent.mustHave.map((f) => (
        <b key={f} className="feature">
          {f}
        </b>
      ))}
      <small>{t.readBy[intent.source]}</small>
    </p>
  )
}

function PriceMemory({ listing, history }) {
  const { t, lang } = useLang()
  if (!history) {
    return (
      <div className="memory">
        <span>{t.memory}</span>
        <strong>{t.memoryNew}</strong>
        <small>{t.memoryNewNote}</small>
      </div>
    )
  }
  const diff = listing.price - history.lastPrice
  return (
    <div className="memory">
      <span>{t.lastChecked}</span>
      <strong>{money(history.lastPrice)}</strong>
      <small className={diff < 0 ? 'down' : diff > 0 ? 'up' : ''}>
        {diff === 0 ? t.noChange : `${diff < 0 ? '↓' : '↑'} ${money(Math.abs(diff))}`} · {t.since} {shortDate(history.lastSeen, lang)} · {t.lowest}{' '}
        {money(history.lowestPrice)}
      </small>
    </div>
  )
}

const STATUS_LABEL = { applies: 'Applies', conditional: 'Applies if…', not_applicable: "Doesn't apply" }

function VoucherChecks({ checks }) {
  const { t } = useLang()
  if (!checks.length) return null
  return (
    <div className="voucher-checks">
      <h4>{t.vouchersChecked}</h4>
      <ul>
        {checks.map((c, i) => (
          <li key={i} className={c.status}>
            <div>
              <b>{c.voucher.title}</b>
              <span>
                {c.voucher.amount != null ? `${money(c.voucher.amount)} off` : `${c.voucher.percent}% off`}
                {c.voucher.minSpend != null && ` · min ${money(c.voucher.minSpend)}`}
              </span>
              <em>{STATUS_LABEL[c.status]}</em>
            </div>
            <ul>
              {[...c.reasons, ...c.conditions].map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Seller({ listing }) {
  const { t } = useLang()
  return (
    <p className="seller">
      {listing.seller}
      {listing.officialStore && <b className="badge badge-strong">Daraz Mall</b>}
      {listing.storeRun && <b className="badge badge-strong">{t.ownStock}</b>}
      {listing.location === 'Overseas' && <b className="badge badge-warm">Ships from overseas</b>}
      {listing.rating ? (
        <span>
          ★ {listing.rating.toFixed(1)} ({listing.reviews})
        </span>
      ) : (
        <span>No ratings yet</span>
      )}
      {listing.sold && <span>{listing.sold}</span>}
    </p>
  )
}

function StoreTag({ site }) {
  return <span className={`store-tag ${site}`}>{STORE_LABEL[site] ?? site}</span>
}

/** How a seller earns trust, in the store's own terms (Cartup products rarely have reviews yet). */
function trustLine(listing) {
  if (listing.rating) return ` · ★ ${listing.rating.toFixed(1)} (${listing.reviews})`
  if (listing.sellerPositive) return ` · seller ${listing.sellerPositive}% positive`
  return ' · no ratings yet'
}

function SaveButton({ listing, query }) {
  const { t } = useLang()
  const watchlist = useWatchlist()
  const saved = watchlist.has(listing.itemId)
  const toggle = () => {
    watchlist.toggle(listing)
    track(saved ? 'unsave' : 'save', { query, listing })
  }
  return (
    <button type="button" className={`btn btn-ghost save-btn${saved ? ' saved' : ''}`} aria-pressed={saved} onClick={toggle}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" />
      </svg>
      {saved ? t.saved : t.save}
    </button>
  )
}

/** "Not what I was looking for": a learning event, thanked once. */
function NotThis({ query, listing }) {
  const { t } = useLang()
  const [sent, setSent] = useState(false)
  if (sent) return <p className="not-this done">{t.notThisThanks}</p>
  return (
    <button
      type="button"
      className="btn-link not-this"
      onClick={() => {
        track('not_this', { query, listing })
        setSent(true)
      }}
    >
      {t.notThis}
    </button>
  )
}

function Flame() {
  return (
    <svg className="flame" viewBox="0 0 24 32" aria-hidden="true">
      <path className="flame-outer" d="M12 0c1 6 7 9 9.500 15 2.500 8-3 17-9.500 17S.5 24 2.500 16c1 2.500 2.500 3.500 4.500 3.500C6 12.500 9 6 12 0z" />
      <path className="flame-inner" d="M12 13c.7 3.500 4.500 5.500 5 9.500.5 4.500-2 8.500-5 8.500s-5.500-4-5-8.500c.4-3.500 4-4.500 5-9.500z" />
    </svg>
  )
}

/**
 * The lowest price of the stores' picks, burning above them (worker/comparison.ts
 * hotDeal). It says a saving only on the same product; different products are
 * called just that.
 */
function HotDealBanner({ deal, query }) {
  const { t } = useLang()
  return (
    <aside className="hot-deal" aria-label={t.hotDeal}>
      <Flame />
      <div className="hot-deal-text">
        <p className="hot-deal-title">
          {t.hotDeal} <StoreTag site={deal.site} />
        </p>
        <h3>{deal.name}</h3>
        <p className="hot-deal-why">{deal.sameProduct ? t.hotSame(money(deal.saving), deal.rival.label) : t.hotPicks(deal.stores)}</p>
      </div>
      <div className="hot-deal-buy">
        <strong>{money(deal.price)}</strong>
        {deal.voucher && <small>{t.withVoucher}</small>}
        <a className="btn btn-hot" href={deal.url} target="_blank" rel="noreferrer" onClick={() => track('open', { query, listing: deal })}>
          {t.open(deal.label)}
        </a>
      </div>
    </aside>
  )
}

/** One store's recommended option: its own pick, never compared away. */
function StorePick({ store, query, hot }) {
  const { t } = useLang()
  const { recommended: result, why, label, site } = store
  const { listing, history, bestVoucher, finalPrice } = result
  const [imgOk, setImgOk] = useState(true)
  return (
    <article className="store-pick">
      {hot && (
        <p className="hot-ribbon">
          <Flame /> {t.hotBadge}
        </p>
      )}
      <div className="store-pick-top">
        <div className="store-pick-media">
          {listing.image && imgOk ? (
            <img src={listing.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
          ) : (
            <span>{listing.name.slice(0, 2)}</span>
          )}
        </div>
        <div className="store-pick-head">
          <p className="eyebrow">{t.recommendedOn(label)}</p>
          <h3>{listing.name}</h3>
          {listing.alsoNamed && <p className="also-named">Listed in {label}'s search as “{listing.alsoNamed}”</p>}
          <Seller listing={listing} />
        </div>
      </div>

      <div className="price-grid">
        <div className="price-main">
          <span>{t.price}</span>
          <strong>{money(listing.price)}</strong>
          {listing.originalPrice ? (
            <small>
              <del>{money(listing.originalPrice)}</del> {listing.discountPercent}% {t.off}
            </small>
          ) : (
            <small>{t.noDiscount}</small>
          )}
        </div>
        <div className={bestVoucher ? 'with-voucher' : ''}>
          <span>{t.withVoucher}</span>
          <strong>{bestVoucher ? money(finalPrice) : '—'}</strong>
          <small>{bestVoucher ? `${bestVoucher.voucher.title} −${money(bestVoucher.saving)}` : site === 'daraz' ? t.noVoucher : t.notTracked}</small>
        </div>
        <PriceMemory listing={listing} history={history} />
      </div>

      {bestVoucher?.conditions.length > 0 && (
        <div className="conditions">
          <span>{t.onlyIf}</span>
          <ul>
            {bestVoucher.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {why && <p className="why">{why}</p>}
      {result.hints.length > 0 && (
        <ul className="notes">
          {result.hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}

      <div className="pick-actions">
        <a className="btn btn-primary" href={listing.url} target="_blank" rel="noreferrer" onClick={() => track('open', { query, listing })}>
          {t.open(label)}
        </a>
        <SaveButton listing={listing} query={query} />
      </div>
      <NotThis key={listing.itemId} query={query} listing={listing} />
    </article>
  )
}

/** One store's other matches, each matched to the product: its other sellers, other sizes, then close matches. */
function StoreMatches({ store, named, query }) {
  const { t } = useLang()
  const { openDialog } = useAccount()
  if (!store.matches.length) return null
  return (
    <div className="store-matches">
      <h4>{named ? t.moreOn(store.label) : t.alsoOn(store.label)}</h4>
      <ul>
        {store.matches.map((r, i) => (
          <li key={r.listing.itemId}>
            <a
              href={r.listing.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => track('open', { query, listing: r.listing, slot: 'match', relation: r.relation, position: i + 1 })}
            >
              <b className={`relation ${r.relation}`}>{r.label}</b>
              <span className="other-name">{r.listing.name}</span>
              {r.listing.alsoNamed && <span className="other-aka">in {store.label}'s search as “{r.listing.alsoNamed}”</span>}
              <span className="other-seller">
                {r.listing.seller}
                {r.listing.officialStore && ' · Daraz Mall'}
                {r.listing.location === 'Overseas' && ' · ships from overseas'}
                {trustLine(r.listing)}
              </span>
            </a>
            <div className="other-price">
              <strong>{money(r.listing.price)}</strong>
              {r.bestVoucher && <small>{money(r.finalPrice)} with voucher</small>}
              {r.history && r.history.lastPrice !== r.listing.price && (
                <small className={r.listing.price < r.history.lastPrice ? 'down' : 'up'}>was {money(r.history.lastPrice)}</small>
              )}
            </div>
          </li>
        ))}
      </ul>
      {store.hiddenMatches > 0 && (
        <button type="button" className="more-locked" onClick={() => openDialog('login')}>
          {t.moreLocked(store.hiddenMatches)}
        </button>
      )}
    </div>
  )
}

/** One store's whole answer. Each store gets one of these, side by side. */
function StoreSection({ store, named, query, hot }) {
  const { t } = useLang()
  const count = (store.recommended ? 1 : 0) + store.matches.length + (store.hiddenMatches ?? 0)
  return (
    <section className={`store-section ${store.site}${hot ? ' is-hot' : ''}`}>
      <header className="store-section-head">
        <StoreTag site={store.site} />
        <span>{t.matches(count)}</span>
        {store.link && (
          <a href={store.link} target="_blank" rel="noreferrer">
            {t.storeResults(store.label)}
          </a>
        )}
      </header>
      {store.recommended ? <StorePick store={store} query={query} hot={hot} /> : <p className="store-empty">{store.note}</p>}
      {store.recommended && store.note && <p className="store-empty">{store.note}</p>}
      <StoreMatches store={store} named={named} query={query} />
      {store.site === 'daraz' && store.recommended && <VoucherChecks checks={store.recommended.vouchers} />}
    </section>
  )
}

const categoryLabel = (slug) => slug.replace(/_\d+$/, '').replace(/_+/g, ' ')

/** Electronics: which three shops to compare on. Reaching three again runs the search on them. */
function ShopPicker({ shops, onShops }) {
  const { t } = useLang()
  const [picked, setPicked] = useState(shops)
  useEffect(() => setPicked(shops), [shops])
  const toggle = (site) => {
    const next = picked.includes(site) ? picked.filter((s) => s !== site) : picked.length < SHOPS_PER_SEARCH ? [...picked, site] : picked
    setPicked(next)
    if (next.length === SHOPS_PER_SEARCH && next.some((s) => !shops.includes(s))) onShops(ALL_SHOPS.filter((s) => next.includes(s)))
  }
  const left = SHOPS_PER_SEARCH - picked.length
  return (
    <div className="shop-picker" role="group" aria-label={t.shopsTitle}>
      <span className="shop-picker-title">{t.shopsTitle}</span>
      {ALL_SHOPS.map((site) => (
        <button
          type="button"
          key={site}
          className={`chip shop-chip ${site}`}
          aria-pressed={picked.includes(site)}
          disabled={!picked.includes(site) && left === 0}
          onClick={() => toggle(site)}
        >
          {STORE_LABEL[site]}
        </button>
      ))}
      {left > 0 && <span className="shop-picker-hint">{t.shopsLeft(left)}</span>}
    </div>
  )
}

function Answer({ answer, onShops }) {
  const { t, lang } = useLang()
  const named = answer.intent.mode === 'product'
  const stores = answer.stores ?? []
  const notes = []
  if (answer.intent.mustHave.length) {
    notes.push(`Features are checked against what each listing's title and highlights mention: ${answer.intent.mustHave.join(', ')}.`)
  }
  if (answer.skippedSuspicious) {
    notes.push(`Left out ${answer.skippedSuspicious} Daraz listing${answer.skippedSuspicious > 1 ? 's' : ''} priced far below the rest — usually parts, accessories, copies or placeholder prices.`)
  }
  const where = stores.map((s) => s.label).join(', ') + (answer.cartupCategories?.length > 0 ? ` (Cartup: ${answer.cartupCategories.map(categoryLabel).join(', ')})` : '')

  return (
    <section className="answer" aria-live="polite">
      {answer.fromLink && (
        <p className="link-gone" role="status">
          {t.linkGone(answer.fromLink.label)}
        </p>
      )}
      <Understood intent={answer.intent} />
      {answer.segment === 'electronics' && onShops && <ShopPicker shops={answer.shops} onShops={onShops} />}
      <p className="searched-where">{t.searched(where, clock(answer.checkedAt, lang))}</p>

      {answer.hotDeal && <HotDealBanner deal={answer.hotDeal} query={answer.query} />}

      <div className="stores-grid" style={{ '--stores': stores.length }}>
        {stores.map((s) => (
          <StoreSection key={s.site} store={s} named={named} query={answer.query} hot={answer.hotDeal?.site === s.site} />
        ))}
      </div>

      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <footer className="answer-meta">
        <span>
          {t.answeredIn} <b>{seconds(answer.timingsMs.total)}</b>
          {STEPS.filter((s) => answer.timingsMs[s.key] != null && (s.key !== 'understand' || answer.intent.source !== 'typed')).map((s) => (
            <i key={s.key}>
              {s.short} {seconds(answer.timingsMs[s.key])}
            </i>
          ))}
          {answer.timingsMs.cartup != null && <i>cartup {seconds(answer.timingsMs.cartup)}</i>}
          {answer.timingsMs.catalogue != null && <i>catalogue {seconds(answer.timingsMs.catalogue)}</i>}
          {answer.timingsMs.scope != null && <i>narrow down {seconds(answer.timingsMs.scope)}</i>}
        </span>
        {answer.cached && <span>{t.fromCache}</span>}
      </footer>

      <details className="caveats">
        <summary>{t.caveats}</summary>
        <ul>
          {answer.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {answer.database !== 'ok' && answer.database !== 'not needed' && <li>Price memory was unreachable for this answer.</li>}
        </ul>
      </details>
    </section>
  )
}

/** A product someone is looking at (a pasted or shared link), on every store. */
function Comparison({ answer }) {
  const { t, lang } = useLang()
  const source = answer.source.listing
  const sourceStore = answer.stores.find((s) => s.site === source.site)
  const other = answer.stores.find((s) => s.site !== source.site && s.recommended)
  const unchecked = answer.stores.filter((s) => (answer.unreachable ?? []).includes(s.site)).map((s) => s.label)
  let verdict
  if (unchecked.length && !answer.cheaper) {
    // A store that couldn't be checked: no claim about the best price.
    verdict = (
      <>
        <b>{t.couldntCheck(unchecked.join(' / '))}</b> {t.tryLater}
      </>
    )
  } else if (answer.cheaper) {
    const where = answer.cheaper.site === source.site ? t.fromOtherSeller(answer.cheaper.label) : t.onStore(answer.cheaper.label)
    verdict = (
      <>
        <b className="cheaper">{t.cheaperWhere(money(answer.cheaper.saving), where)}</b> {t.sameProduct}
      </>
    )
  } else {
    verdict = (
      <>
        <b>{t.bestFound}</b> {other ? t.elsewhere(other.label, money(other.recommended.finalPrice)) : t.nowhereElse}
      </>
    )
  }
  return (
    <section className="answer" aria-live="polite">
      <p className="understood">
        <span>{t.comparing}</span>
        <b>“{source.name}”</b>
        <small>
          {money(answer.source.finalPrice)} · {sourceStore?.label ?? source.site}
        </small>
      </p>
      <p className="compare-verdict">{verdict}</p>
      <p className="searched-where">{t.searched(answer.stores.map((s) => s.label).join(', '), clock(answer.checkedAt, lang))}</p>
      {answer.hotDeal && <HotDealBanner deal={answer.hotDeal} query={source.name} />}
      <div className="stores-grid" style={{ '--stores': answer.stores.length }}>
        {answer.stores.map((s) => (
          <StoreSection key={s.site} store={s} named hot={answer.hotDeal?.site === s.site} />
        ))}
      </div>
    </section>
  )
}

function SearchIcon() {
  return (
    <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/**
 * The hero search and its answer. `request` ({ ask, id }) runs a search
 * started elsewhere on the page: a popular search, or "compare" in the watchlist.
 */
export default function AskAgent({ stats, request }) {
  const { t, lang } = useLang()
  const { user, guest, setGuest, openDialog } = useAccount()
  const [form, setForm] = useState(askFromUrl)
  const [showDetails, setShowDetails] = useState(() => Boolean(askFromUrl().details))
  const [state, setState] = useState({ status: 'idle', answer: null, error: null, asked: null })
  const [elapsed, setElapsed] = useState(0)
  const [recent, setRecent] = useState(loadRecent)
  const controller = useRef(null)
  const nameRef = useRef(null)
  const resultsRef = useRef(null)
  // What to run again after logging in: a search the guest limit stopped, or one with rows held back.
  const afterLogin = useRef(null)
  // Answers this page already has: going back to one shouldn't spend a guest's free search.
  const seen = useRef(new Map())

  const run = useCallback((raw, { push = true, scroll = false } = {}) => {
    const ask = { name: tidy(raw.name), details: tidy(raw.details) }
    if ((ask.name + ask.details).length < 2) return
    controller.current?.abort()
    const ctrl = new AbortController()
    controller.current = ctrl
    setForm(ask)
    if (ask.details) setShowDetails(true)
    if (push) setUrlAsk(ask)
    setState({ status: 'asking', answer: null, error: null, asked: ask })
    if (scroll) window.requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    const started = performance.now()
    setElapsed(0)
    const tick = window.setInterval(() => setElapsed(performance.now() - started), 100)
    const link = STORE_LINK.test(ask.name)
    ;(link ? compareLink(ask.name, ctrl.signal) : askAgent(ask, ctrl.signal))
      .then((answer) => {
        setState({ status: 'done', answer, error: null, asked: ask })
        seen.current.set(askKey(ask), { answer, at: Date.now() })
        afterLogin.current = answer.stores?.some((s) => s.hiddenMatches) ? ask : null
        if (answer.guest) setGuest(answer.guest)
        if (link) return // links are long, and already in the address bar to come back to
        setRecent((list) => {
          const next = [ask, ...list.filter((x) => !sameAsk(x, ask))].slice(0, 6)
          saveRecent(next)
          return next
        })
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        if (error.needLogin) {
          if (error.guest) setGuest(error.guest)
          afterLogin.current = ask
          setState({ status: 'wall', answer: null, error: null, asked: ask })
          openDialog('limit')
          return
        }
        setState({ status: 'error', answer: null, error: error.message || "Couldn't reach the agent.", asked: ask })
      })
      .finally(() => window.clearInterval(tick))
  }, [setGuest, openDialog])

  useEffect(() => {
    if (!user || !afterLogin.current) return
    const ask = afterLogin.current
    afterLogin.current = null
    run(ask, { push: false })
  }, [user, run])

  // A shared link opens straight onto its answer; back/forward replays them.
  useEffect(() => {
    const initial = askFromUrl()
    if (initial.name || initial.details) run(initial, { push: false })
    const onPop = () => {
      const ask = askFromUrl()
      const kept = seen.current.get(askKey(ask))
      if (kept && Date.now() - kept.at < KEEP_ANSWER_MS) {
        controller.current?.abort()
        setForm(ask)
        setState({ status: 'done', answer: kept.answer, error: null, asked: ask })
      } else if (ask.name || ask.details) run(ask, { push: false })
      else {
        controller.current?.abort()
        setForm({ name: '', details: '' })
        setState({ status: 'idle', answer: null, error: null, asked: null })
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [run])

  useEffect(() => {
    if (request) run(request.ask, { scroll: true })
  }, [request, run])

  const asking = state.status === 'asking'
  const chips = recent.length ? recent : EXAMPLES
  const ready = (tidy(form.name) + tidy(form.details)).length >= 2

  return (
    <>
      <section className="hero" id="search">
        <p className="hero-badge">{t.badge}</p>
        <h1>{t.heroTitle}</h1>
        <p className="hero-copy">{t.heroCopy}</p>

        <form
          className="search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            run(form)
          }}
        >
          <div className="search-row">
          <div className="search-box">
            <SearchIcon />
            <label htmlFor="ask-name" className="visually-hidden">
              {t.searchLabel}
            </label>
            <input
              id="ask-name"
              ref={nameRef}
              value={form.name}
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
              placeholder={t.searchPlaceholder}
              autoComplete="off"
              enterKeyHint="search"
              maxLength={600}
            />
            {(form.name || form.details) && !asking && (
              <button
                type="button"
                className="search-clear"
                aria-label={t.clear}
                onClick={() => {
                  setForm({ name: '', details: '' })
                  nameRef.current?.focus()
                }}
              >
                ✕
              </button>
            )}
          </div>
            <button type="submit" className="btn btn-primary search-submit" disabled={asking || !ready}>
              {asking ? t.finding : t.submit}
              <span aria-hidden="true">→</span>
            </button>
          </div>

          {showDetails ? (
            <div className="details-box">
              <label htmlFor="ask-details">{t.detailsLabel}</label>
              <input
                id="ask-details"
                value={form.details}
                onChange={(event) => setForm((f) => ({ ...f, details: event.target.value }))}
                placeholder={t.detailsPlaceholder}
                autoComplete="off"
                enterKeyHint="search"
                maxLength={300}
              />
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  setShowDetails(false)
                  setForm((f) => ({ ...f, details: '' }))
                }}
              >
                {t.hideDetails}
              </button>
            </div>
          ) : (
            <button type="button" className="btn-link add-details" onClick={() => setShowDetails(true)}>
              {t.addDetails}
            </button>
          )}
          <p className="search-hint">{t.searchHint}</p>
          {!user && guest && (
            <p className="guest-left">
              {guest.used >= guest.limit ? t.guestNone : t.guestLeft(guest.limit - guest.used, guest.limit)}{' '}
              <button type="button" className="btn-link" onClick={() => openDialog('login')}>
                {t.logIn}
              </button>
            </p>
          )}
        </form>

        <div className="chips">
          <span>{recent.length ? t.recentLabel : t.tryLabel}</span>
          {chips.map((ask) => (
            <button type="button" className="chip" key={label(ask)} onClick={() => run(ask)} disabled={asking}>
              {ask.name}
              {ask.name && ask.details && ' · '}
              {ask.details}
            </button>
          ))}
        </div>

        <p className="hero-stores">
          <span className="live-dot" aria-hidden="true" />
          {t.liveFrom}: <span className="store-tag daraz">Daraz</span> <span className="store-tag cartup">Cartup</span> <span className="store-tag othoba">Othoba</span>
          {stats?.totals?.asks > 0 && <em>{t.record(stats.totals.asks.toLocaleString(locale(lang)), seconds(stats.totals.avg_ms ?? 0))}</em>}
        </p>
      </section>

      <div className="results" id="results" ref={resultsRef}>
        {asking && <Progress elapsed={elapsed} readsDetails={readsText(state.asked)} />}
        {state.status === 'wall' && (
          <div className="error-box" role="alert">
            <strong>{t.limitTitle}</strong>
            <p>{t.limitBody}</p>
            <button type="button" className="btn btn-primary btn-small" onClick={() => openDialog('limit')}>
              {t.logIn}
            </button>
          </div>
        )}
        {state.status === 'error' && (
          <div className="error-box" role="alert">
            <strong>{t.errorTitle(label(state.asked))}</strong>
            <p>{state.error}</p>
            <button type="button" className="btn btn-ghost" onClick={() => run(state.asked, { push: false })}>
              {t.tryAgain}
            </button>
          </div>
        )}
        {state.status === 'done' && state.answer && (state.answer.source ? <Comparison answer={state.answer} /> : <Answer
              answer={state.answer}
              onShops={(shops) => {
                saveShops(shops)
                run(state.asked, { push: false })
              }}
            />)}
      </div>
    </>
  )
}
