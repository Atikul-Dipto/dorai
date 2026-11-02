/**
 * DorAI's scheduled jobs: a Worker on a free cron trigger (wrangler.toml,
 * every 10 minutes), separate from the Pages site because Pages Functions
 * can't run on a timer. Each run:
 *
 *   1. queues a price check for every watched product not checked in 6 hours
 *      (one per product, however many devices watch it);
 *   2. takes a few due checks off the queue and reads each product's current
 *      listing through its store adapter (worker/stores.ts);
 *   3. records the price (price history), updates the watches, and sends an
 *      alert (worker/notify.ts) where a drop is worth telling;
 *   4. tidies the queue.
 *
 * A few checks per run on purpose: Daraz bot-checks bursts from Cloudflare,
 * and the free plan's CPU budget per run is small. 3 per 10 minutes is up to
 * ~430 checks a day, enough for ~100 watched products every 6 hours.
 */

import { notify } from '../worker/notify.ts'
import { claim, complete, fail, tidy } from '../worker/queue.ts'
import { recordListings } from '../worker/store.ts'
import { type Site, STORES } from '../worker/stores.ts'
import type { Env } from '../worker/types.ts'
import { enqueueDueChecks, recordCheck } from '../worker/watchlist.ts'

const CHECKS_PER_RUN = 3

interface CheckPayload {
  itemId: string
  site: Site
  url: string
  name: string
}

export async function runJobs(env: Env, now = new Date()): Promise<{ checked: number; alerts: number; failed: number }> {
  const db = env.PP_DB
  const done = { checked: 0, alerts: 0, failed: 0 }
  if (!db) return done
  const iso = now.toISOString()
  await enqueueDueChecks(db, iso)

  for (const task of await claim(db, 'check_price', CHECKS_PER_RUN, iso)) {
    try {
      const p = JSON.parse(task.payload) as CheckPayload
      const adapter = STORES[p.site]
      if (!adapter) throw new Error(`No adapter for "${p.site}".`)
      const listing = await adapter.current({ itemId: p.itemId, url: p.url, name: p.name }, env)
      if (listing) await recordListings(db, [listing], iso)
      // Gone or sold out: checked, with no price to compare.
      const due = await recordCheck(db, p.itemId, listing?.inStock ? listing.price : null, iso)
      if (due.length && listing) {
        const marks = due.map(() => '?').join(', ')
        const { results: devices } = await db
          .prepare(`SELECT id, lang, push_endpoint, telegram_chat FROM devices WHERE id IN (${marks})`)
          .bind(...due.map((w) => w.device_id))
          .all<{ id: string; lang: string; push_endpoint: string | null; telegram_chat: string | null }>()
        for (const w of due) {
          const d = devices.find((x) => x.id === w.device_id)
          if (!d || (!d.push_endpoint && !d.telegram_chat)) continue
          await notify(
            db,
            env,
            {
              deviceId: d.id,
              itemId: w.item_id,
              site: w.site,
              name: listing.name,
              url: w.url,
              oldPrice: w.alerted_price ?? w.saved_price,
              newPrice: listing.price,
              lang: d.lang,
              pushEndpoint: d.push_endpoint,
              telegramChat: d.telegram_chat,
            },
            iso,
          )
          done.alerts++
        }
      }
      await complete(db, task, iso)
      done.checked++
    } catch (e) {
      await fail(db, task, e instanceof Error ? e.message : String(e), iso)
      done.failed++
    }
  }
  await tidy(db, iso)
  return done
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runJobs(env))
  },
}
