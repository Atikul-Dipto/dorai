import { useCallback, useEffect, useRef, useState } from 'react'
import { useLang } from '../i18n.js'
import { compareLink } from './api.js'
import { deviceStatus, enablePush, ensureDevice, forgetDevice, loadDevice, pushSupported, syncWatches, telegramLink, testPush } from './device.js'
import { money } from './format.js'
import { STORE_LABEL } from './stores.js'
import { useWatchlist } from './watchlist.js'

const shortDate = (iso, lang) => new Date(iso).toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-GB', { day: 'numeric', month: 'short' })
const clock = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : [], { hour: '2-digit', minute: '2-digit' })

/**
 * Price-drop alerts: turning them on makes this browser a device on the
 * server (no account), sends it the watchlist, and asks for notifications;
 * Telegram is offered once the bot is set up.
 */
function AlertsPanel({ device, setDevice }) {
  const { t, lang } = useLang()
  const { items } = useWatchlist()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(
    (d) =>
      deviceStatus(d)
        .then(setStatus)
        .catch((e) => {
          // The server no longer knows this device: start over.
          if (e.status === 401) forgetDevice(d).then(() => setDevice(null))
        }),
    [setDevice],
  )
  useEffect(() => {
    if (device) refresh(device)
  }, [device, refresh])

  const act = async (work) => {
    setBusy(true)
    setMessage('')
    try {
      await work()
    } catch (e) {
      if (e.pushService) setMessage(navigator.brave ? t.alertsBrave : t.alertsPushService)
      else setMessage(e.denied ? t.alertsDenied : e.message || t.alertsFailed)
    } finally {
      setBusy(false)
    }
  }

  const turnOn = () =>
    act(async () => {
      const d = await ensureDevice(lang)
      setDevice(d)
      const s = await deviceStatus(d)
      if (items.length) await syncWatches(d, items)
      if (pushSupported() && s.vapidPublicKey) await enablePush(d, s.vapidPublicKey)
      else if (!s.telegram) setMessage(t.alertsNoPush)
      await refresh(d)
    })

  if (!device) {
    return (
      <section className="alerts">
        <h3>{t.alertsTitle}</h3>
        <p>{t.alertsPitch}</p>
        <button type="button" className="btn btn-primary btn-small" onClick={turnOn} disabled={busy}>
          {busy ? t.alertsWorking : t.alertsTurnOn}
        </button>
        {message && <p className="alerts-message">{message}</p>}
      </section>
    )
  }

  return (
    <section className="alerts on">
      <h3>{t.alertsTitle}</h3>
      <p className="alerts-channels">
        {t.alertsChannels}: <b className={status?.push ? 'on' : ''}>{t.alertsPush} · {status?.push ? t.alertsOnLabel : t.alertsOffLabel}</b>
        {status?.telegram && (
          <b className={status?.telegramLinked ? 'on' : ''}>
            {t.alertsTelegram} · {status?.telegramLinked ? t.alertsOnLabel : t.alertsOffLabel}
          </b>
        )}
      </p>
      <div className="watch-actions">
        {status && !status.push && pushSupported() && status.vapidPublicKey && (
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => act(() => enablePush(device, status.vapidPublicKey).then(() => refresh(device)))}>
            {t.alertsEnablePush}
          </button>
        )}
        {status?.telegram && !status.telegramLinked && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const { url } = await telegramLink(device)
                window.open(url, '_blank', 'noopener')
                setMessage(t.telegramWaiting)
              })
            }
          >
            {t.alertsConnectTelegram}
          </button>
        )}
        {status?.push && (
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => act(() => testPush(device).then(() => setMessage(t.alertsTestSent)))}>
            {t.alertsTest}
          </button>
        )}
        <button
          type="button"
          className="btn-link"
          disabled={busy}
          onClick={() =>
            act(async () => {
              await forgetDevice(device)
              setDevice(null)
              setStatus(null)
            })
          }
        >
          {t.alertsOff}
        </button>
      </div>
      <p className="alerts-how">{t.alertsHow}</p>
      {message && <p className="alerts-message">{message}</p>}
    </section>
  )
}

function WatchItem({ item, alertsOn, onCompare }) {
  const { t, lang } = useLang()
  const { remove, recordCheck, setTarget } = useWatchlist()
  const [status, setStatus] = useState('idle')
  const [imgOk, setImgOk] = useState(true)
  const [target, setTargetText] = useState(item.targetPrice ? String(item.targetPrice) : '')

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
  const saveTarget = () => {
    const n = Number(target.replace(/[^\d.]/g, ''))
    const next = Number.isFinite(n) && n > 0 ? n : null
    if (next !== (item.targetPrice ?? null)) setTarget(item.itemId, next)
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
        {alertsOn && (
          <label className="watch-target">
            {t.targetLabel} ৳
            <input
              inputMode="numeric"
              value={target}
              placeholder={String(Math.round(item.price * 0.95))}
              onChange={(e) => setTargetText(e.target.value)}
              onBlur={saveTarget}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        )}
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

/** The watchlist drawer: alerts, then saved products with their saved and current prices. */
export default function Watchlist({ open, onClose, onCompare }) {
  const { t } = useLang()
  const { items } = useWatchlist()
  const [device, setDevice] = useState(loadDevice)
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
        <AlertsPanel device={device} setDevice={setDevice} />
        {items.length ? (
          <ul className="watch-list">
            {items.map((item) => (
              <WatchItem
                key={item.itemId}
                item={item}
                alertsOn={Boolean(device)}
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
