/**
 * Which shops a search compares: always three. Electronics can be compared on
 * any three of the five shops, the shopper's choice; everything else is
 * compared on Daraz, Cartup and Othoba, which sell every kind of thing.
 */

import { tokens } from './ranking.ts'
import type { Intent, Listing } from './types.ts'

export type Site = Listing['site']
export const ALL_SITES: Site[] = ['daraz', 'cartup', 'othoba', 'startech', 'pickaboo']
export const SITE_LABEL: Record<Site, string> = { daraz: 'Daraz', cartup: 'Cartup', othoba: 'Othoba', startech: 'Star Tech', pickaboo: 'Pickaboo' }
export const SHOPS_PER_SEARCH = 3
export const GENERAL_SHOPS: Site[] = ['daraz', 'cartup', 'othoba']
// The two electronics specialists, and the biggest marketplace.
export const ELECTRONICS_SHOPS: Site[] = ['daraz', 'startech', 'pickaboo']

export type Segment = 'electronics' | 'general'

const KINDS = new Set(
  `phone phones smartphone smartphones mobile mobiles iphone ipad tablet laptop laptops notebook macbook chromebook desktop pc computer
   monitor monitors keyboard keyboards mouse mice headphone headphones headset headsets earphone earphones earbud earbuds earbuds tws neckband
   speaker speakers soundbar router routers modem ssd hdd nvme ram processor cpu gpu motherboard psu casing printer printers scanner
   toner cartridge projector camera cameras webcam dslr lens gimbal tripod smartwatch smartwatches drone console playstation ps5 xbox controller
   gamepad joystick powerbank charger adapter tv television ups ips pendrive microsd sdcard microphone mic graphics trimmer shaver
   refrigerator fridge freezer ac airconditioner inverter oven microwave blender juicer kettle iron washingmachine dryer vacuum geyser airfryer
   memorycard graphicscard smarttv androidtv`
    .split(/\s+/)
    .filter(Boolean),
)
const BRANDS = new Set(
  `samsung xiaomi redmi poco realme oppo vivo iqoo oneplus infinix tecno itel walton symphony nokia motorola huawei google pixel
   logitech a4tech fantech havit rapoo redragon razer corsair hyperx steelseries asus acer msi lenovo dell hp gigabyte intel amd nvidia
   jbl sony anker baseus hoco awei joyroom ugreen remax qcy haylou amazfit edifier soundcore tp-link tplink mercusys tenda mikrotik
   canon nikon epson kingston sandisk transcend seagate adata lexar crucial dji gopro insta360 kemei philips panasonic lg
   haier hisense minister jamuna`
    .split(/\s+/)
    .filter(Boolean),
)

/**
 * Electronics when the words name a kind of device or one of its brands. Words
 * that are everyday words too (apple, vision, sharp, switch, flash) aren't here:
 * a wrong guess only changes which shops are shown first.
 */
export function segmentOf(intent: Pick<Intent, 'searchQuery' | 'productType' | 'brand'>): Segment {
  const words = [intent.searchQuery, intent.productType ?? '', intent.brand ?? ''].flatMap((t) => tokens(t))
  // Two-word kinds too: "power bank", "washing machine".
  const pairs = words.slice(1).map((w, i) => words[i] + w)
  return [...words, ...pairs].some((w) => KINDS.has(w) || BRANDS.has(w)) ? 'electronics' : 'general'
}

/** The shops a search shows: the shopper's three for electronics, when they chose a valid three. */
export function shopsFor(segment: Segment, chosen: unknown): Site[] {
  if (segment !== 'electronics') return GENERAL_SHOPS
  const picked = Array.isArray(chosen) ? [...new Set(chosen.filter((s): s is Site => ALL_SITES.includes(s as Site)))] : []
  return picked.length === SHOPS_PER_SEARCH ? ALL_SITES.filter((s) => picked.includes(s)) : ELECTRONICS_SHOPS
}
