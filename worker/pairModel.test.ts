/** The same-product model (pairModel.ts) with its trained weights (pairWeights.ts). */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseListing } from './catalog.ts'
import { pairFeatures, type PairSide, sameProbability } from './pairModel.ts'
import { WEIGHTS } from './pairWeights.ts'

const side = (name: string, site = 'daraz', price: number | null = 500, brand = ''): PairSide => ({ name, parsed: parseListing(name, brand, null), price, site })

test('the weights were trained on every clue the model reads', () => {
  const clues = Object.keys(pairFeatures(side('Awei T50 Earbuds'), side('Awei T50 Earbuds', 'cartup'), false)).sort()
  // A clue added without retraining (node scripts/train-matcher.ts) would silently count for nothing.
  assert.deepEqual(Object.keys(WEIGHTS.coef).sort(), clues)
  assert.match(WEIGHTS.trained, /pairs; out of fold/)
})

test('the same product across shops is sure; a flavour, a scent or a pack count makes another product', () => {
  assert.ok(sameProbability(side('Hoco EQ10 Plus ANC Earbuds - Black', 'othoba', 1167), side('Hoco EQ10 Plus ANC Earbuds', 'daraz', 1399)) >= 0.8)
  assert.ok(sameProbability(side('Starship Full Cream Milk Powder – 1 Kg', 'cartup', 700, 'Starship'), side('Starship Full Cream Milk Powder - 1kg', 'daraz', 700, 'Starship')) >= 0.8)
  assert.ok(sameProbability(side('Lux Body Wash Freesia Scent & Aloe Vera 245ml', 'daraz', 209), side('Lux Body Wash Black Orchid Scent & Juniper Oil 245ml', 'cartup', 99)) < 0.2)
  assert.ok(sameProbability(side('Tiger Dotted Condoms Orange Flavor | Combo Pack - 3x3=9pcs', 'othoba', 93), side('Tiger - Dotted Condoms Chocolate Flavour - Combo Pack - 3x3=9pcs', 'othoba', 104)) < 0.5)
  assert.ok(sameProbability(side('Cudy M1300 (3-Pack) AC1200 Dual Band Mesh Wi-Fi', 'othoba', 9357), side('Cudy M1300 (2-Pack) AC1200 Dual Band Mesh Wi-Fi', 'othoba', 6263)) < 0.8)
})

test('a pair the hard rules refuse is never the same product, whatever the words', () => {
  assert.equal(sameProbability(side('Pran Mango Juice 1L'), side('Pran Mango Juice 250ml')), 0)
  assert.equal(sameProbability(side('Samsung Galaxy A36 8/128GB'), side('Samsung Galaxy A56 8/128GB')), 0)
})

test('a pair costs well under a millisecond, titles parsed included', () => {
  const a = 'Xiaomi ENCHEN Boost 2 Electric Hair Trimmer | Hair Trimmer for men | Beard Trimmer | Cordless Clipper'
  const b = 'Xiaomi ENCHEN Boost 2 Rechargeable Electric Hair Trimmer & Clipper for Men - Cordless Hair Trimmer with Adjustable Comb'
  const started = performance.now()
  for (let i = 0; i < 200; i++) sameProbability(side(a + i, 'daraz', 2399), side(b, 'daraz', 1800))
  const each = (performance.now() - started) / 200
  assert.ok(each < 0.5, `${each.toFixed(3)} ms a pair`)
})
