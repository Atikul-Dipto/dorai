// Who's on the page: an account or a guest with free searches left
// (worker/access.ts). The session is an HttpOnly cookie, so the page only ever
// asks the server. `dialog` is the account window's view, or null.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAuth, sendAuth } from './api.js'

export const AccountContext = createContext(null)
export const useAccount = () => useContext(AccountContext)

export function useAccountState() {
  const [user, setUser] = useState(null)
  const [guest, setGuest] = useState(null)
  const [ready, setReady] = useState(false)
  const [dialog, setDialog] = useState(null)

  useEffect(() => {
    getAuth()
      .then((who) => {
        setUser(who.user)
        setGuest(who.guest)
      })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  const openDialog = useCallback((view) => setDialog(view), [])
  const closeDialog = useCallback(() => setDialog(null), [])

  /** Sends an account action; a server refusal arrives as an Error with its `code`. */
  const send = useCallback(async (action, fields) => {
    const who = await sendAuth(action, fields)
    setUser(who.user)
    if (who.guest !== undefined) setGuest(who.guest)
    return who
  }, [])

  return useMemo(() => ({ user, guest, ready, dialog, setGuest, openDialog, closeDialog, send, setUser }), [user, guest, ready, dialog, openDialog, closeDialog, send])
}
