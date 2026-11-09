/**
 * polite.ts: Daraz is asked as little as possible, left alone after a bot
 * check, and its earlier results are shown with their age when it can't be
 * reached. Cloudflare's cache and the clock are stand-ins here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DarazBusy } from './daraz.ts'
import { FRESH_SECONDS, olderNote, PAUSE_SECONDS, search, unreachedNote } from './polite.ts'

/** Cloudflare's cache as far as polite.ts uses it: match and put, honouring max-age against `clock`. */
function withCacheAndClock(start: number) {
  const kept = new Map<string, { body: string; until: number }>()
  const state = { clock: start }
  const realNow = Date.now
  const realCaches = (globalThis as { caches?: unknown }).caches
  Date.now = () => state.clock
  ;(globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (key: string) => {
        const hit = kept.get(key)
        return hit && hit.until > state.clock ? new Response(hit.body) : undefined
      },
      put: async (key: string, response: Response) => {
        const seconds = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0)
        kept.set(key, { body: await response.text(), until: state.clock + seconds * 1000 })
      },
    },
  }
  const restore = () => {
    Date.now = realNow
    ;(globalThis as { caches?: unknown }).caches = realCaches
  }
  return { state, restore }
}

const DARAZ_JSON = JSON.stringify({ mods: { listItems: [{ itemId: '111', name: 'Awei T50 Wireless Earbuds', itemUrl: '//www.daraz.com.bd/products/awei-t50-i111.html', price: '1100' }] } })

test('Daraz: the same search is read once in a while, and after a bot check Daraz is left alone, with earlier results shown with their age', async () => {
  const start = Date.parse('2026-11-09T10:00:00Z')
  const { state, restore } = withCacheAndClock(start)
  const realFetch = globalThis.fetch
  let answer: 'json' | 'check' = 'json'
  let asked = 0
  globalThis.fetch = (async () => {
    asked++
    return answer === 'json' ? new Response(DARAZ_JSON, { headers: { 'content-type': 'application/json' } }) : new Response('<script>check</script>')
  }) as typeof fetch
  try {
    const live = await search('Awei T50')
    assert.equal(live.listings[0].itemId, '111')
    assert.equal(live.asOf, undefined)
    // The same words, however typed: from the cache, Daraz not asked.
    await search('  awei   T50 ')
    assert.equal(asked, 1)

    // Half an hour on, Daraz bot-checks: what it said earlier, said to be earlier.
    state.clock += (FRESH_SECONDS + 60) * 1000
    answer = 'check'
    const older = await search('Awei T50')
    assert.equal(asked, 2)
    assert.equal(older.listings[0].itemId, '111')
    assert.equal(older.asOf, '2026-11-09T10:00:00.000Z')
    assert.match(olderNote(older.asOf!, state.clock), /prices from 31 minutes ago/)

    // While paused, nothing is asked of Daraz: a search it never answered fails, and says why.
    await assert.rejects(search('pran milk powder'), (e) => e instanceof DarazBusy)
    assert.equal(asked, 2)
    assert.match(unreachedNote(new Error(new DarazBusy().message)), /bot check/)
    assert.match(unreachedNote(new Error('Daraz search returned 500')), /try again in a moment/)

    // After the pause, Daraz is asked again.
    state.clock += (PAUSE_SECONDS + 1) * 1000
    answer = 'json'
    const back = await search('pran milk powder')
    assert.equal(asked, 3)
    assert.equal(back.asOf, undefined)
  } finally {
    globalThis.fetch = realFetch
    restore()
  }
})

test('Daraz: a bot check answered as 403 or 429 counts as one too; another failure does not pause it', async () => {
  const { restore } = withCacheAndClock(Date.parse('2026-11-09T12:00:00Z'))
  const realFetch = globalThis.fetch
  let status = 500
  let asked = 0
  globalThis.fetch = (async () => {
    asked++
    return new Response('', { status })
  }) as typeof fetch
  try {
    await assert.rejects(search('lotion'), /returned 500/)
    await assert.rejects(search('lotion'), /returned 500/)
    assert.equal(asked, 2) // not paused: Daraz was asked again
    status = 429
    await assert.rejects(search('lotion'), (e) => e instanceof DarazBusy)
    await assert.rejects(search('soap'), (e) => e instanceof DarazBusy)
    assert.equal(asked, 3) // paused
  } finally {
    globalThis.fetch = realFetch
    restore()
  }
})
