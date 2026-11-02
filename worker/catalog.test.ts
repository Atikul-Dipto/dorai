// The matching pipeline's model codes, on titles from the live listings (2026-11-03).
//   node --test worker/catalog.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { catalogModel } from './catalog.ts'

test("a title's model code: its first real code, never a spec, a size or a multiplier", () => {
  const cases: [string, string | null][] = [
    ['Hoco | EQ34 Plus VIXON | True Wireless Earbuds (TWS) | ANC + ENC | Bluetooth 5.4 | Lightweight 4.4g', 'eq34'],
    ['SmarToools RB40 AA 1.5V 2600mWh Rechargeable Battery (4/2 Pcs Set)', 'rb40'],
    ['Asus Vivobook Go 15 L1504FA (BQ2548W) AMD Ryzen 5 7520U', 'l1504fa'],
    ['Sony WH-1000XM5 Wireless Headphones', 'wh1000xm5'],
    ['Apple iPhone 15 128GB', 'iphone15'],
    ['Mobile Casing for Nokia 215', 'nokia215'],
    ['Xiaomi Redmi Note 17 8GB/256GB', 'note17'],
    ['Samsung Galaxy A36 5G 8/256GB', 'a36'],
    ['Vmax V17 Pro Max (6+6)12 GB RAM 128GB ROM', 'v17'],
    ['CURREN 9015 Stainless Steel Watch For Women', 'curren9015'],
    ['Kodomo Pink Hanabaki Baby Lotion Powder 0+ Baby 180G', null],
    ['New 3 in 1 Bluetooth Gaming Keyboard Mouse Converter', null],
    ['Samyang Hot Chicken Flavor Ramen 3x Spicy Noodles - 140g', null],
    ['Binni Rice (White) 1 kg pack (100% Mix free)', null],
  ]
  for (const [name, want] of cases) assert.equal(catalogModel(name), want, name)
})
