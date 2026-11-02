/**
 * The task queue (D1 `tasks`), drained by the scheduled jobs (jobs/index.ts).
 * One pending task per kind + key: a product watched by many devices is
 * checked once. A task that fails is retried later, three times at most.
 */

import type { D1Database } from './types.ts'

export interface Task {
  id: number
  kind: string
  key: string
  payload: string
  attempts: number
}

const MAX_ATTEMPTS = 3
const RETRY_MINUTES = 30
const KEEP_DAYS = 7

export async function enqueue(db: D1Database, kind: string, key: string, payload: unknown, now: string, runAfter = now): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO tasks (kind, key, payload, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(kind, key, JSON.stringify(payload ?? {}), runAfter, now, now)
    .run()
}

/** Up to `limit` due tasks of a kind, marked running so an overlapping run doesn't take them too. */
export async function claim(db: D1Database, kind: string, limit: number, now: string): Promise<Task[]> {
  const { results } = await db
    .prepare(
      `UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ?1
        WHERE id IN (SELECT id FROM tasks WHERE kind = ?2 AND status = 'pending' AND run_after <= ?1 ORDER BY run_after LIMIT ?3)
        RETURNING id, kind, key, payload, attempts`,
    )
    .bind(now, kind, limit)
    .all<Task>()
  return results
}

export async function complete(db: D1Database, task: Task, now: string): Promise<void> {
  await db.prepare(`UPDATE tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).bind(now, task.id).run()
}

/** Back to pending for a later try, or failed for good after the last attempt. */
export async function fail(db: D1Database, task: Task, error: string, now: string): Promise<void> {
  const retry = task.attempts < MAX_ATTEMPTS
  const later = new Date(Date.parse(now) + RETRY_MINUTES * task.attempts * 60_000).toISOString()
  // OR IGNORE: if a fresh task for the same key is already pending, that one stands.
  if (retry) await db.prepare(`UPDATE OR IGNORE tasks SET status = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?`).bind(later, error.slice(0, 300), now, task.id).run()
  await db.prepare(`UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'`).bind(error.slice(0, 300), now, task.id).run()
}

/** Finished tasks are kept a week for looking into, then dropped; a run that died mid-task frees its tasks after an hour. */
export async function tidy(db: D1Database, now: string): Promise<void> {
  const week = new Date(Date.parse(now) - KEEP_DAYS * 86400_000).toISOString()
  const hour = new Date(Date.parse(now) - 3600_000).toISOString()
  await db.batch([
    db.prepare(`DELETE FROM tasks WHERE status IN ('done', 'failed') AND updated_at < ?`).bind(week),
    db.prepare(`UPDATE OR IGNORE tasks SET status = 'pending' WHERE status = 'running' AND updated_at < ?`).bind(hour),
    db.prepare(`DELETE FROM tasks WHERE status = 'running' AND updated_at < ?`).bind(hour),
  ])
}
