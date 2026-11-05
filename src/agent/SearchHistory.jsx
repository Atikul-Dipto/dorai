import { useState } from 'react'
import { useLang } from '../i18n.js'
import { forgetHistory } from './api.js'
import { allowHistory, declineHistory, historyChoice, visitorId } from './visitor.js'

/**
 * The shopper's say over search history: a bar that asks once, and a line in
 * the footer to turn it off (which deletes it) or on. Nothing is linked to
 * anyone until they say yes here.
 */
export default function SearchHistory() {
  const { t } = useLang()
  const [choice, setChoice] = useState(historyChoice)
  const [asking, setAsking] = useState(false)
  const [failed, setFailed] = useState(false)

  const decide = (allowed) => {
    if (allowed) allowHistory()
    else declineHistory()
    setChoice(allowed ? 'yes' : 'no')
    setAsking(false)
  }

  async function forget() {
    setFailed(false)
    try {
      await forgetHistory(visitorId())
      decide(false)
    } catch {
      setFailed(true)
    }
  }

  return (
    <>
      <span className="history-state">
        {choice === 'yes' ? t.historyOn : t.historyOff}{' '}
        <button type="button" className="btn-link" onClick={choice === 'yes' ? forget : () => setAsking(true)}>
          {choice === 'yes' ? t.historyForget : t.historyTurnOn}
        </button>
        {failed && <span role="alert"> {t.historyFailed}</span>}
      </span>
      {(asking || choice === null) && (
        <aside className="history-bar" aria-labelledby="history-title">
          <h2 id="history-title">{t.historyAsk}</h2>
          <p>{t.historyPitch}</p>
          <div className="history-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={() => decide(true)}>
              {t.historyYes}
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => decide(false)}>
              {t.historyNo}
            </button>
          </div>
        </aside>
      )}
    </>
  )
}
