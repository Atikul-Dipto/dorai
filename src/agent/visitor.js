// Search history, only for a shopper who says yes (SearchHistory.jsx): a random
// id for this browser, sent with searches and learning events so they can be
// read together (worker/profiles.ts). With no id, nothing links them to anyone.
const ID_KEY = 'dorai:visitor-v1'
const NO_KEY = 'dorai:visitor-no'

export function visitorId() {
  try {
    return localStorage.getItem(ID_KEY)
  } catch {
    return null
  }
}

/** 'yes', 'no', or null when they haven't been asked. Blocked storage can't keep an id, so it counts as no. */
export function historyChoice() {
  try {
    if (localStorage.getItem(ID_KEY)) return 'yes'
    return localStorage.getItem(NO_KEY) ? 'no' : null
  } catch {
    return 'no'
  }
}

export function allowHistory() {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    localStorage.setItem(ID_KEY, id)
    localStorage.removeItem(NO_KEY)
  } catch {
    // Storage blocked: nothing can be kept, so nothing is linked.
  }
}

export function declineHistory() {
  try {
    localStorage.removeItem(ID_KEY)
    localStorage.setItem(NO_KEY, '1')
  } catch {
    // Storage blocked: there's no id to remove.
  }
}
