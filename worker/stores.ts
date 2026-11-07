/**
 * Store adapters behind one interface. Each store module keeps its own way of
 * searching (daraz.ts: Daraz's search JSON; cartup.ts and othoba.ts: their
 * name indexes in D1 plus product pages), because the stores allow different
 * things. This is what any caller can ask every store, the same way: find
 * listings for a title, and read one product's current listing again (the
 * scheduled price checks). Listings come out normalized (normalize.ts).
 */

import * as cartup from './cartup.ts'
import { readProductUrl } from './links.ts'
import * as daraz from './daraz.ts'
import { coreQuery } from './intent.ts'
import * as othoba from './othoba.ts'
import * as pickaboo from './pickaboo.ts'
import * as startech from './startech.ts'
import type { Env, Listing } from './types.ts'

export type Site = Listing['site']

/** What a scheduled check knows about a product: its key, address and name. */
export interface ItemRef {
  itemId: string
  url: string
  name: string
}

export interface StoreAdapter {
  site: Site
  label: string
  find(title: string, env: Env): Promise<Listing[]>
  current(item: ItemRef, env: Env): Promise<Listing | null>
}

/**
 * Daraz's product pages bot-check sooner than its search, so a Daraz
 * product's current listing is read from a search for its name (then its
 * brand + model code, which lists every seller), never its page.
 */
async function darazCurrent(item: ItemRef): Promise<Listing | null> {
  for (const q of [item.name, coreQuery(item.name)]) {
    if (!q) continue
    const hit = (await daraz.search(q)).listings.find((l) => l.itemId === item.itemId)
    if (hit) return hit
  }
  return null
}

/** A retailer's listing, read again from a search for its name. */
const byName = (search: (q: string) => Promise<Listing[]>) => async (item: ItemRef) => {
  for (const q of [item.name, coreQuery(item.name)]) {
    if (!q) continue
    const hit = (await search(q)).find((l) => l.itemId === item.itemId)
    if (hit) return hit
  }
  return null
}

export const STORES: Record<Site, StoreAdapter> = {
  startech: { site: 'startech', label: 'Star Tech', find: (title) => startech.search(title), current: byName(startech.search) },
  pickaboo: { site: 'pickaboo', label: 'Pickaboo', find: (title) => pickaboo.search(title), current: byName(pickaboo.search) },
  daraz: {
    site: 'daraz',
    label: 'Daraz',
    find: async (title) => (await daraz.search(title)).listings,
    current: darazCurrent,
  },
  cartup: {
    site: 'cartup',
    label: 'Cartup',
    find: async (title, env) => (await cartup.lookup(env.PP_DB, title)).listings,
    current: async (item) => {
      const ref = readProductUrl(item.url)
      return ref?.site === 'cartup' ? cartup.fetchProduct(ref.slug) : null
    },
  },
  othoba: {
    site: 'othoba',
    label: 'Othoba',
    find: async (title, env) => (await othoba.lookup(env.PP_DB, title)).listings,
    current: async (item) => {
      const ref = readProductUrl(item.url)
      return ref?.site === 'othoba' ? othoba.fetchProduct(ref.slug) : null
    },
  },
}
