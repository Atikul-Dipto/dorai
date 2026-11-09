/**
 * Trains the same-product model (worker/pairModel.ts) on the labelled pairs in
 * data/matching/: pairs.jsonl (from the live catalogue) and labels.txt
 * (1 same, 0 different, u unsure: unsure pairs are left out).
 *
 *   node scripts/train-matcher.ts            measure, then write worker/pairWeights.ts
 *   node scripts/train-matcher.ts --dry      measure only (--verbose lists the mistakes)
 *
 * The measurement is out of fold: every pair is scored by a model that never
 * saw it, nor any other pair about the same product.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { parseListing } from '../worker/catalog.ts'
import { pairFeatures, type PairSide } from '../worker/pairModel.ts'

interface Pair {
  id: number
  kind: string
  a_site: string
  a_name: string
  a_brand: string | null
  a_image: string | null
  a_price: number | null
  b_site: string | null
  b_name: string
  b_brand: string | null
  b_image: string | null
  b_price: number | null
  score: number
}

const root = new URL('../', import.meta.url)
const pairs = readFileSync(new URL('data/matching/pairs.jsonl', root), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Pair)
const labels = new Map(
  readFileSync(new URL('data/matching/labels.txt', root), 'utf8')
    .split('\n')
    .filter((l) => /^\d/.test(l))
    .map((l) => l.trim().split(/\s+/) as [string, string]),
)

const side = (site: string | null, name: string, brand: string | null, image: string | null, price: number | null): PairSide => ({
  name,
  parsed: parseListing(name, brand, image),
  price,
  site: site ?? '?',
})
type Row = { pair: Pair; y: number; f: Record<string, number> }
const rows: Row[] = pairs.flatMap((p) => {
  const label = labels.get(String(p.id))
  if (label !== '0' && label !== '1') return []
  const a = side(p.a_site, p.a_name, p.a_brand, p.a_image, p.a_price)
  const b = side(p.b_site, p.b_name, p.b_brand, p.b_image, p.b_price)
  const samePhoto = Boolean(a.parsed.photo && a.parsed.photo === b.parsed.photo)
  return [{ pair: p, y: Number(label), f: pairFeatures(a, b, samePhoto) }]
})
const NAMES = Object.keys(rows[0].f)

// ---- logistic regression, L2, full-batch gradient descent on standardized features ----
type Model = { intercept: number; coef: Record<string, number>; mean: Record<string, number>; scale: Record<string, number> }
function fit(train: Row[], lambda = 0.02, steps = 3000, rate = 0.3): Model {
  const mean: Record<string, number> = {}
  const scale: Record<string, number> = {}
  for (const n of NAMES) {
    const v = train.map((r) => r.f[n])
    mean[n] = v.reduce((s, x) => s + x, 0) / v.length
    scale[n] = Math.sqrt(v.reduce((s, x) => s + (x - mean[n]) ** 2, 0) / v.length) || 1
  }
  const X = train.map((r) => NAMES.map((n) => (r.f[n] - mean[n]) / scale[n]))
  const w = NAMES.map(() => 0)
  let b = Math.log(train.filter((r) => r.y).length / train.filter((r) => !r.y).length)
  for (let step = 0; step < steps; step++) {
    const g = NAMES.map(() => 0)
    let gb = 0
    X.forEach((x, i) => {
      const p = 1 / (1 + Math.exp(-(b + x.reduce((s, v, j) => s + v * w[j], 0))))
      const e = p - train[i].y
      gb += e
      x.forEach((v, j) => (g[j] += e * v))
    })
    b -= (rate * gb) / X.length
    w.forEach((_, j) => (w[j] -= rate * (g[j] / X.length + lambda * w[j])))
  }
  return { intercept: b, coef: Object.fromEntries(NAMES.map((n, j) => [n, w[j]])), mean, scale }
}
const predict = (m: Model, f: Record<string, number>) =>
  f.rules === 0 ? 0 : 1 / (1 + Math.exp(-(m.intercept + NAMES.reduce((s, n) => s + m.coef[n] * ((f[n] - m.mean[n]) / m.scale[n]), 0))))

// ---- out-of-fold scores, folds grouped by product ----
const FOLDS = 5
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const foldOf = (r: Row) => hash(r.pair.b_name.toLowerCase()) % FOLDS
const oof = new Map<Row, number>()
for (let k = 0; k < FOLDS; k++) {
  const m = fit(rows.filter((r) => foldOf(r) !== k))
  for (const r of rows.filter((r) => foldOf(r) === k)) oof.set(r, predict(m, r.f))
}
const model = (r: Row) => oof.get(r)!

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
function at(threshold: number, score: (r: Row) => number) {
  const yes = rows.filter((r) => score(r) >= threshold)
  const right = yes.filter((r) => r.y).length
  return { linked: yes.length, precision: right / (yes.length || 1), recall: right / rows.filter((r) => r.y).length, wrong: yes.length - right }
}
function auc(score: (r: Row) => number) {
  const s = rows.map((r) => [score(r), r.y] as const).sort((a, b) => a[0] - b[0])
  let rank = 0
  let pos = 0
  s.forEach(([, y], i) => {
    if (y) {
      rank += i + 1
      pos++
    }
  })
  return (rank - (pos * (pos + 1)) / 2) / (pos * (s.length - pos))
}

console.log(`${rows.length} labelled pairs (${rows.filter((r) => r.y).length} same, ${rows.filter((r) => !r.y).length} different); ${FOLDS}-fold, grouped by product`)
const rulesNow = at(0.8, (r) => r.pair.score)
console.log(`rules today (links at score >= 0.8): ${rulesNow.linked} linked, precision ${pct(rulesNow.precision)}, recall ${pct(rulesNow.recall)}, ${rulesNow.wrong} wrong; AUC ${auc((r) => r.pair.score).toFixed(3)}`)
console.log(`model, out of fold: AUC ${auc(model).toFixed(3)}`)
for (const t of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const r = at(t, model)
  console.log(`  links at >= ${t}: ${r.linked} linked, precision ${pct(r.precision)}, recall ${pct(r.recall)}, ${r.wrong} wrong`)
}
// The lowest threshold whose links are at least 95% right, out of fold.
const AUTO = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].find((t) => at(t, model).precision >= 0.95) ?? 0.95
const sure = at(AUTO, model)
const low = rows.filter((r) => model(r) < 0.2)
console.log(`auto-link threshold ${AUTO}: precision ${pct(sure.precision)}, recall ${pct(sure.recall)}; below 0.2: ${low.length} pairs, ${low.filter((r) => r.y).length} of them the same`)

if (process.argv.includes('--verbose')) {
  for (const r of rows.filter((r) => (r.y === 0 && model(r) >= AUTO) || (r.y === 1 && model(r) < 0.2)))
    console.log(`  ${r.y ? 'MISSED' : 'WRONG '} ${model(r).toFixed(2)} #${r.pair.id}: ${r.pair.a_name.slice(0, 60)} | ${r.pair.b_name.slice(0, 60)}`)
}

const final = fit(rows)
console.log(
  'weights (standardized):',
  Object.entries(final.coef)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([n, w]) => `${n} ${w.toFixed(2)}`)
    .join(', '),
)
if (!process.argv.includes('--dry')) {
  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]))
  const out = {
    intercept: Math.round(final.intercept * 1e4) / 1e4,
    coef: round(final.coef),
    mean: round(final.mean),
    scale: round(final.scale),
    trained: `${new Date().toISOString().slice(0, 10)}: ${rows.length} pairs; out of fold AUC ${auc(model).toFixed(3)}, at ${AUTO} precision ${pct(sure.precision)} recall ${pct(sure.recall)}`,
    autoThreshold: AUTO,
  }
  writeFileSync(
    new URL('worker/pairWeights.ts', root),
    `// Written by scripts/train-matcher.ts from data/matching/ — don't edit by hand.\nexport const WEIGHTS: { intercept: number; coef: Record<string, number>; mean: Record<string, number>; scale: Record<string, number>; trained: string; autoThreshold: number } = ${JSON.stringify(out, null, 2)}\n`,
  )
  console.log('wrote worker/pairWeights.ts')
}
