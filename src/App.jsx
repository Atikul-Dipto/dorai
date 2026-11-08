import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import './agent/agent.css'
import AccountDialog from './agent/AccountDialog.jsx'
import AskAgent from './agent/AskAgent.jsx'
import GetDorAI from './agent/GetDorAI.jsx'
import SearchHistory from './agent/SearchHistory.jsx'
import Watchlist from './agent/Watchlist.jsx'
import { AccountContext, useAccountState } from './agent/account.js'
import { getStats } from './agent/api.js'
import { useWatchlistState, WatchlistContext } from './agent/watchlist.js'
import { LangContext, loadLang, POPULAR, saveLang, STRINGS } from './i18n.js'

const BASE = import.meta.env.BASE_URL

// Line icons for the "why" cards (24px grid, stroke only).
const ICONS = [
  <path key="search" d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5M8 11h6M11 8v6" />,
  <path key="compare" d="M4 7h16M4 12h10M4 17h13M18 10l3 2-3 2" />,
  <path key="memory" d="M3 17l5-5 4 3 8-8M15 7h5v5" />,
  <path key="watch" d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" />,
]

/**
 * DorAI's page: the search (hero) with its answer, then popular searches,
 * how it works, why DorAI, and the app and extension.
 * Bangla first, with an English switch; the watchlist lives in this browser.
 * (The older scraped-prices dashboard was removed 2026-10-29; the scrapers
 * and their backend still live in scraper/ and backend/.)
 */
export default function App() {
  const [lang, setLang] = useState(loadLang)
  const [agentStats, setAgentStats] = useState(null)
  const [watchOpen, setWatchOpen] = useState(false)
  const [request, setRequest] = useState(null)
  const watchlist = useWatchlistState()
  const account = useAccountState()
  const t = STRINGS[lang]
  const langValue = useMemo(() => ({ lang, t }), [lang, t])

  useEffect(() => {
    document.documentElement.lang = lang
    saveLang(lang)
  }, [lang])

  // The agent's running record, from the Cloudflare function it runs on.
  useEffect(() => {
    getStats()
      .then(setAgentStats)
      .catch(() => setAgentStats(null))
  }, [])

  const search = useCallback((ask) => setRequest({ ask, id: Date.now() }), [])
  const closeWatch = useCallback(() => setWatchOpen(false), [])

  return (
    <LangContext.Provider value={langValue}>
      <AccountContext.Provider value={account}>
      <WatchlistContext.Provider value={watchlist}>
        <div className="page">
          <header className="topbar">
            <a className="brand" href={BASE} aria-label="DorAI">
              <img src={`${BASE}logo-wordmark.png`} srcSet={`${BASE}logo-wordmark.png 1x, ${BASE}logo-wordmark-360.png 3x`} alt="দরAI" height="52" />
            </a>
            <nav className="topnav">
              <a href="#how" className="hide-small">
                {t.navHow}
              </a>
              <button type="button" className="nav-watch" aria-label={t.navWatchlist} onClick={() => setWatchOpen(true)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" />
                </svg>
                <span className="hide-small">{t.navWatchlist}</span>
                {watchlist.items.length > 0 && <b>{watchlist.items.length}</b>}
              </button>
              {account.ready && (
                <button
                  type="button"
                  className={`nav-account${account.user ? ' signed-in' : ''}`}
                  aria-label={account.user ? t.accountTitle : undefined}
                  onClick={() => account.openDialog(account.user ? 'account' : 'login')}
                >
                  {account.user ? account.user.email[0].toUpperCase() : t.logIn}
                </button>
              )}
              <button type="button" className="lang-switch" onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')} lang={lang === 'bn' ? 'en' : 'bn'}>
                {t.switchTo}
              </button>
            </nav>
          </header>

          <main>
            <AskAgent stats={agentStats} request={request} />

            <section className="section" aria-labelledby="popular-title">
              <h2 id="popular-title">{t.popularTitle}</h2>
              <div className="popular">
                {POPULAR.map((p) => (
                  <button type="button" key={p.q} className="chip chip-large" onClick={() => search({ name: p.q, details: '' })}>
                    {p[lang]}
                  </button>
                ))}
              </div>
            </section>

            <section className="section" id="how" aria-labelledby="how-title">
              <h2 id="how-title">{t.howTitle}</h2>
              <ol className="how">
                {t.how.map(([title, body], i) => (
                  <li key={title}>
                    <span className="how-step">{(i + 1).toLocaleString(lang === 'bn' ? 'bn-BD' : 'en')}</span>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="section" aria-labelledby="why-title">
              <h2 id="why-title">{t.whyTitle}</h2>
              <ul className="why-grid">
                {t.why.map(([title, body], i) => (
                  <li key={title}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      {ICONS[i]}
                    </svg>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </li>
                ))}
              </ul>
            </section>

            <GetDorAI />

          </main>

          <footer className="footer">
            <span>{t.footer}</span>
            <SearchHistory />
            <a href="https://github.com/Atikul-Dipto/dorai" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </footer>
        </div>

        <Watchlist open={watchOpen} onClose={closeWatch} onCompare={(url) => search({ name: url, details: '' })} />
        <AccountDialog />
      </WatchlistContext.Provider>
      </AccountContext.Provider>
    </LangContext.Provider>
  )
}
