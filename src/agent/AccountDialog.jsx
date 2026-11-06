import { useEffect, useRef, useState } from 'react'
import { useLang } from '../i18n.js'
import { useAccount } from './account.js'
import { deleteAccount } from './api.js'
import { visitorId } from './visitor.js'

/** One labelled field of the account window. */
function Field({ label, hint, ...input }) {
  return (
    <label className="account-field">
      <span>{label}</span>
      <input {...input} required />
      {hint && <small>{hint}</small>}
    </label>
  )
}

/**
 * The account window. Views: login, limit (login, after the free searches),
 * signup, forgot, code (a new recovery code, shown once), account.
 */
export default function AccountDialog() {
  const { t } = useLang()
  const { user, dialog, openDialog, closeDialog, send, setUser, setGuest } = useAccount()
  const [form, setForm] = useState({ email: '', password: '', code: '', history: Boolean(visitorId()) })
  const [recoveryCode, setRecoveryCode] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const panel = useRef(null)

  useEffect(() => {
    if (!dialog) return undefined
    setError(null)
    setDeleting(false)
    setForm((f) => ({ ...f, password: '', code: '' }))
    window.requestAnimationFrame(() => (panel.current?.querySelector('input') ?? panel.current?.querySelector('.btn'))?.focus())
    const onKey = (event) => {
      if (event.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, closeDialog])

  if (!dialog) return null

  const field = (name) => ({ value: form[name], onChange: (event) => setForm((f) => ({ ...f, [name]: event.target.value })) })

  async function submit(event, work) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(t.accountErrors[e.code] ?? t.accountErrors.failed)
    } finally {
      setBusy(false)
    }
  }

  const showCode = (who) => {
    setRecoveryCode(who.recoveryCode)
    openDialog('code')
  }

  const logIn = (event) => submit(event, async () => {
    await send('login', { email: form.email, password: form.password, visitor: visitorId() ?? undefined })
    closeDialog()
  })
  const signUp = (event) => submit(event, async () => showCode(await send('signup', { email: form.email, password: form.password, history: form.history, visitor: visitorId() ?? undefined })))
  const reset = (event) => submit(event, async () => showCode(await send('reset', { email: form.email, code: form.code, password: form.password })))
  const remove = (event) => submit(event, async () => {
    const who = await deleteAccount(form.password)
    setUser(null)
    setGuest(who.guest)
    closeDialog()
  })
  const logOut = (event) => submit(event, async () => {
    await send('logout')
    closeDialog()
  })

  const loginView = dialog === 'login' || dialog === 'limit'

  return (
    <div className="drawer-backdrop account-backdrop" onClick={dialog === 'code' ? undefined : closeDialog}>
      <div className="account-panel" role="dialog" aria-modal="true" aria-labelledby="account-title" ref={panel} onClick={(event) => event.stopPropagation()}>
        {dialog !== 'code' && (
          <button type="button" className="btn-link account-close" aria-label={t.close} onClick={closeDialog}>
            ✕
          </button>
        )}

        {loginView && (
          <form onSubmit={logIn}>
            <h2 id="account-title">{dialog === 'limit' ? t.limitTitle : t.logIn}</h2>
            {dialog === 'limit' && <p className="account-note">{t.limitBody}</p>}
            <Field label={t.emailLabel} type="email" autoComplete="email" {...field('email')} />
            <Field label={t.passwordLabel} type="password" autoComplete="current-password" {...field('password')} />
            {error && <p className="account-error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>{t.logIn}</button>
            <div className="account-links">
              <button type="button" className="btn-link" onClick={() => openDialog('signup')}>{t.needAccount}</button>
              <button type="button" className="btn-link" onClick={() => openDialog('forgot')}>{t.forgotPassword}</button>
            </div>
          </form>
        )}

        {dialog === 'signup' && (
          <form onSubmit={signUp}>
            <h2 id="account-title">{t.signUp}</h2>
            <p className="account-note">{t.signUpBody}</p>
            <Field label={t.emailLabel} type="email" autoComplete="email" {...field('email')} />
            <Field label={t.passwordLabel} hint={t.passwordHint} type="password" autoComplete="new-password" minLength={8} {...field('password')} />
            <label className="account-check">
              <input type="checkbox" checked={form.history} onChange={(event) => setForm((f) => ({ ...f, history: event.target.checked }))} />
              <span>{t.signUpHistory}</span>
            </label>
            {error && <p className="account-error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>{t.signUp}</button>
            <div className="account-links">
              <button type="button" className="btn-link" onClick={() => openDialog('login')}>{t.haveAccount}</button>
            </div>
          </form>
        )}

        {dialog === 'forgot' && (
          <form onSubmit={reset}>
            <h2 id="account-title">{t.forgotPassword}</h2>
            <p className="account-note">{t.forgotBody}</p>
            <Field label={t.emailLabel} type="email" autoComplete="email" {...field('email')} />
            <Field label={t.codeLabel} autoComplete="off" spellCheck={false} {...field('code')} />
            <Field label={t.newPasswordLabel} hint={t.passwordHint} type="password" autoComplete="new-password" minLength={8} {...field('password')} />
            {error && <p className="account-error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>{t.resetPassword}</button>
            <div className="account-links">
              <button type="button" className="btn-link" onClick={() => openDialog('login')}>{t.haveAccount}</button>
            </div>
          </form>
        )}

        {dialog === 'code' && (
          <div>
            <h2 id="account-title">{t.codeTitle}</h2>
            <p className="account-note">{t.codeBody}</p>
            <p className="account-code">{recoveryCode}</p>
            <button type="button" className="btn btn-primary" onClick={closeDialog}>{t.codeSaved}</button>
          </div>
        )}

        {dialog === 'account' && user && (
          <div>
            <h2 id="account-title">{t.accountTitle}</h2>
            <p className="account-note">{user.email}</p>
            {error && !deleting && <p className="account-error" role="alert">{error}</p>}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={logOut}>{t.logOut}</button>
            {deleting ? (
              <form onSubmit={remove} className="account-delete">
                <p className="account-note">{t.deleteBody}</p>
                <Field label={t.passwordLabel} type="password" autoComplete="current-password" {...field('password')} />
                {error && <p className="account-error" role="alert">{error}</p>}
                <button className="btn btn-ghost" disabled={busy}>{t.deleteAccount}</button>
              </form>
            ) : (
              <div className="account-links">
                <button type="button" className="btn-link" onClick={() => setDeleting(true)}>{t.deleteAccount}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
