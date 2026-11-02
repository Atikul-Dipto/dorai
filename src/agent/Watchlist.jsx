import { useEffect, useRef, useState } from 'react'
import { useLang } from '../i18n.js'
import { compareLink } from './api.js'
import { money } from './format.js'
import { STORE_LABEL } from './stores.js'
import { useWatchlist } from './watchlist.js'

const shortDate = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'short' })
const clock = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : [], { hour: '2-digit', minute: '2-digit' })

function WatchItem({ item, onCompare }) {
  const { t, lang } = useLang()
  const { remove, recordCheck } = useWatchlist()
  const [status, setStatus] = useState('idle')
  const [imgOk, setImgOk] = useState(true)

  const check = () => {
    setStatus('checking')
    compareLink(item.url)
      .then((result) => {
        if (result.error || !result.source) throw new Error(result.error)
        recordCheck(item.itemId, { price: result.source.listing.price, at: result.checkedAt, cheaper: result.cheaper ?? null })
        setStatus('idle')
      })
      .catch(() => setStatus('failed'))
  }

  const now = item.check
  const diff = now ? now.price - item.price : 0
  return (
    <li className="watch-item">
      <div className="watch-media">{item.image && imgOk ? <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} /> : <span>{item.name.slice(0, 2)}</span>}</div>
      <div className="watch-body">
        <span className={`store-tag ${item.site}`}>{STORE_LABEL[item.site] ?? item.site}</span>
        <a className="watch-name" href={item.url} target="_blank" rel="noreferrer">
          {item.name}
        </a>
        <small>{t.watchSavedAt(money(item.price), shortDate(item.savedAt, lang))}</small>
        {now && (
          <small className={diff < 0 ? 'down' : diff > 0 ? 'up' : ''}>
            {t.watchNow(money(now.price), clock(now.at, lang))}
            {diff !== 0 && ` (${diff < 0 ? '↓' : '↑'} ${money(Math.abs(diff))})`}
          </small>
        )}
        {now?.cheaper && <small className="down">{t.watchCheaper(money(now.cheaper.saving), now.cheaper.label)}</small>}
        {status === 'failed' && <small className="up">{t.watchFailed}</small>}
        <div className="watch-actions">
          <button type="button" className="btn btn-small" onClick={check} disabled={status === 'checking'}>
            {status === 'checking' ? t.watchChecking : t.watchCheck}
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onCompare(item.url)}>
            {t.watchCompare}
          </button>
          <button type="button" className="btn-link" onClick={() => remove(item.itemId)}>
            {t.watchRemove}
          </button>
        </div>
      </div>
    </li>
  )
}

/** The watchlist drawer: saved products, their saved and current prices. */
export default function Watchlist({ open, onClose, onCompare }) {
  const { t } = useLang()
  const { items } = useWatchlist()
  const closeRef = useRef(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="watch-title" onClick={(event) => event.stopPropagation()}>
        <header className="drawer-head">
          <h2 id="watch-title">{t.watchTitle}</h2>
          <button type="button" ref={closeRef} className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>
        <p className="drawer-note">{t.watchDevice}</p>
        {items.length ? (
          <ul className="watch-list">
            {items.map((item) => (
              <WatchItem
                key={item.itemId}
                item={item}
                onCompare={(url) => {
                  onClose()
                  onCompare(url)
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="empty">{t.watchEmpty}</p>
        )}
      </aside>
    </div>
  )
}
