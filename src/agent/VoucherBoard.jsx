import { useLang } from '../i18n.js'
import { money } from './format.js'

const COPY = {
  bn: {
    eyebrow: 'এজেন্ট যা মিলিয়ে দেখে',
    title: 'Daraz-এর পাবলিক ভাউচার, এখন',
    collected: (when) => `Daraz-এর ক্যাম্পেইন পাতা থেকে নেওয়া (${when})।`,
    error: 'ভাউচারের তালিকা আনা গেল না।',
    none: 'এই মুহূর্তে Daraz-এর ক্যাম্পেইন পাতায় কোনো পাবলিক ভাউচার নেই। 11.11-এর মতো সেলে এগুলো একসাথে ফেরে।',
    footnote: 'স্টোর ভাউচার, নতুন গ্রাহকের অফার আর Daraz Coins শুধু লগ-ইন করা Daraz অ্যাকাউন্টে দেখা যায়, তাই এখানে নেই।',
  },
  en: {
    eyebrow: 'What the agent checks against',
    title: 'Public Daraz vouchers right now',
    collected: (when) => `Collected from Daraz campaign pages ${when}.`,
    error: "Couldn't load the voucher list.",
    none: "No public vouchers are live on Daraz's campaign pages at the moment. They return in bulk around sales like 11.11.",
    footnote: "Store vouchers, new-user offers and Daraz Coins only show to a logged-in Daraz account, so they aren't here.",
  },
}

function ago(iso) {
  if (!iso) return 'never'
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3600000)
  if (hours < 1) return 'within the hour'
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)} days ago`
}

const day = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

function campaign(url) {
  try {
    const slug = (new URL(url).searchParams.get('wh_pid') ?? '').replace(/\/+$/, '').split('/').pop()
    return slug && slug !== 'home' ? slug.replace(/[-_]+/g, ' ') : null
  } catch {
    return null
  }
}

// The public Daraz vouchers the agent checks every answer against. Collected
// from Daraz's campaign pages (agent/vouchers.py) — product pages show none
// to a logged-out visitor, so store and personal vouchers can't be listed.
export default function VoucherBoard({ data, status }) {
  const c = COPY[useLang().lang]
  return (
    <section className="section" id="vouchers" aria-labelledby="vouchers-title">
      <p className="eyebrow">{c.eyebrow}</p>
      <h2 id="vouchers-title">{c.title}</h2>
      {data && <p className="muted">{c.collected(ago(data.harvestedAt))}</p>}
      {status === 'error' && <p className="empty">{c.error}</p>}
      {data && data.results.length === 0 && <p className="empty">{c.none}</p>}
      {data && data.results.length > 0 && (
        <ul className="voucher-list">
          {data.results.map((v, i) => (
            <li key={i}>
              <strong>{v.amount != null ? `${money(v.amount)} off` : `${v.percent}% off`}</strong>
              <span className="voucher-terms">
                {v.minSpend != null ? `on orders over ${money(v.minSpend)}` : 'no minimum'}
                {v.maxDiscount != null && ` · capped at ${money(v.maxDiscount)}`}
              </span>
              <span className="voucher-title">{v.title}</span>
              <span className="voucher-labels">
                {v.labels.map((l) => (
                  <b key={l}>{l}</b>
                ))}
              </span>
              <small>
                {v.validFrom && v.validTo ? `${day(v.validFrom)} – ${day(v.validTo)}` : v.validTo ? `until ${day(v.validTo)}` : ''}
                {campaign(v.sourceUrl) && ` · ${campaign(v.sourceUrl)} campaign`}
              </small>
            </li>
          ))}
        </ul>
      )}
      <p className="voucher-footnote">{c.footnote}</p>
    </section>
  )
}
