/**
 * Self-checks: twice an hour (jobs/index.ts, its own cron) each shop's reader
 * is tried on something the shop certainly sells, and the database on a
 * trivial read. The outcome is kept in `health` (one row per shop) and shown
 * at /api/pp/health, so a reader that breaks (Cartup moving off www, Daraz
 * bot-checking, a site redesign, the database out of reads) is known within
 * the hour rather than from a shopper's screen. After ALERT_AFTER failed
 * checks in a row the owner is told once on Telegram (ALERT_TELEGRAM_CHAT),
 * and once more when the shop is back.
 *
 * A failing shop is never retried harder: the checks are as polite as a
 * search (Daraz through polite.ts, one page each for the rest).
 */

import * as cartup from './cartup.ts'
import { sendTelegram } from './notify.ts'
import * as othoba from './othoba.ts'
import * as pickaboo from './pickaboo.ts'
import * as polite from './polite.ts'
import { SITE_LABEL } from './segments.ts'
import * as startech from './startech.ts'
import type { D1Database, Env } from './types.ts'

/** Failed checks in a row before the owner is told: two checks half an hour apart. */
export const ALERT_AFTER = 2

export type Checked = 'daraz' | 'cartup' | 'othoba' | 'startech' | 'pickaboo' | 'database'
export const LABEL: Record<Checked, string> = { ...SITE_LABEL, database: 'The database' }

export interface Probe {
  site: Checked
  ok: boolean
  detail: string // what was wrong; '' when fine
}

/** Each check answers '' when the shop is fine, else what's wrong. One that throws is a failure too. */
const PROBES: Record<Checked, (env: Env) => Promise<string>> = {
  daraz: async () => {
    const found = await polite.search('awei t50')
    if (found.asOf) return `only its results from ${found.asOf} (bot check or unreachable)`
    return found.listings.length ? '' : 'search answered with no listings'
  },
  cartup: async () => ((await cartup.fetchCategory('mice')).length ? '' : 'the "mice" section page had no listings'),
  othoba: async () => ((await othoba.search('awei')).length ? '' : 'search answered with no hits'),
  startech: async () => ((await startech.search('logitech mouse')).length ? '' : 'search answered with no listings'),
  pickaboo: async () => ((await pickaboo.search('logitech mouse')).length ? '' : 'search answered with no listings'),
  database: async (env) => {
    if (!env.PP_DB) return 'no database binding'
    await env.PP_DB.prepare('SELECT item_id FROM listings LIMIT 1').first()
    return ''
  },
}

export async function probeAll(env: Env, sites: Checked[] = Object.keys(PROBES) as Checked[]): Promise<Probe[]> {
  return Promise.all(
    sites.map(async (site) => {
      try {
        const detail = await PROBES[site](env)
        return { site, ok: !detail, detail }
      } catch (e) {
        return { site, ok: false, detail: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
}

interface HealthRow {
  site: string
  ok: number
  detail: string
  checked_at: string
  failing_since: string | null
  fails: number
  alerted: number
}

/**
 * Keeps the probes' outcomes and tells the owner, through `tell`, of a shop
 * failing for the ALERT_AFTER-th check in a row (once), and of one that's back
 * after being told about. Returns what was told.
 */
export async function recordHealth(db: D1Database, probes: Probe[], now: string, tell: (text: string) => Promise<unknown>): Promise<string[]> {
  const { results } = await db.prepare(`SELECT site, fails, alerted, failing_since FROM health`).all<Pick<HealthRow, 'site' | 'fails' | 'alerted' | 'failing_since'>>()
  const known = new Map(results.map((r) => [r.site, r]))
  const told: string[] = []
  const writes = probes.map((p) => {
    const was = known.get(p.site)
    const fails = p.ok ? 0 : (was?.fails ?? 0) + 1
    const since = p.ok ? null : (was?.failing_since ?? now)
    let alerted = p.ok ? 0 : (was?.alerted ?? 0)
    if (!p.ok && !alerted && fails >= ALERT_AFTER) {
      told.push(`DorAI: ${LABEL[p.site]} has been failing since ${since!.slice(0, 16).replace('T', ' ')} UTC: ${p.detail}`)
      alerted = 1
    }
    if (p.ok && was?.alerted) told.push(`DorAI: ${LABEL[p.site]} is back.`)
    return db
      .prepare(
        `INSERT INTO health (site, ok, detail, checked_at, failing_since, fails, alerted) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, checked_at = excluded.checked_at,
           failing_since = excluded.failing_since, fails = excluded.fails, alerted = excluded.alerted`,
      )
      .bind(p.site, p.ok ? 1 : 0, p.detail.slice(0, 300), now, since, fails, alerted)
  })
  // Told first: if the write fails, the database is the news.
  for (const text of told) await tell(text).catch(() => {})
  await db.batch(writes)
  return told
}

/** What /api/pp/health shows. */
export async function readHealth(db: D1Database) {
  const { results } = await db.prepare(`SELECT site, ok, detail, checked_at, failing_since FROM health ORDER BY site`).all<HealthRow>()
  return results.map((r) => ({
    site: r.site,
    label: LABEL[r.site as Checked] ?? r.site,
    ok: r.ok === 1,
    detail: r.detail,
    checkedAt: r.checked_at,
    failingSince: r.failing_since,
  }))
}

/** One round of checks, as the cron runs it. */
export async function selfCheck(env: Env, now = new Date()): Promise<{ probes: Probe[]; told: string[] }> {
  const probes = await probeAll(env)
  const chat = env.ALERT_TELEGRAM_CHAT
  const tell = chat ? (text: string) => sendTelegram(chat, text, env) : async () => 'sent' as const
  if (!env.PP_DB) return { probes, told: [] }
  try {
    return { probes, told: await recordHealth(env.PP_DB, probes, now.toISOString(), tell) }
  } catch (e) {
    // The record itself can't be kept: the database is what's down. With no
    // memory of having said so, it's said once an hour (the :05 run).
    const told: string[] = []
    if (now.getUTCMinutes() < 30) {
      const text = `DorAI: the database can't be used (${e instanceof Error ? e.message.slice(0, 120) : e}). Searches still answer, without price memory; Cartup by name and accounts are off until it's back.`
      await tell(text).catch(() => {})
      told.push(text)
    }
    return { probes, told }
  }
}
