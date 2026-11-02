import { useEffect, useState } from 'react'
import { useLang } from '../i18n.js'

const EXTENSION_SOURCE = 'https://github.com/Atikul-Dipto/dorai/tree/main/extension'

const COPY = {
  bn: {
    phone: 'ফোনে',
    installed: 'DorAI ইনস্টল করা আছে। Daraz, Cartup বা Othoba অ্যাপে কোনো পণ্যে Share চেপে DorAI বেছে নিন, তুলনা দেখাবে।',
    iphone: 'Safari-তে Share চেপে “Add to Home Screen” বেছে নিন। তুলনা করতে স্টোরের অ্যাপ থেকে পণ্যের লিংক কপি করে উপরের বক্সে পেস্ট করুন।',
    android: 'DorAI অ্যাপ হিসেবে ইনস্টল করুন। তারপর Daraz, Cartup বা Othoba অ্যাপে যেকোনো পণ্যে Share চেপে DorAI বেছে নিলেই সব দোকানে দাম দেখাবে।',
    install: 'DorAI ইনস্টল করুন',
    menu: 'Chrome-এর মেনু থেকে “Add to Home screen” বা “Install app” বেছে নিন।',
    computer: 'কম্পিউটারে',
    extension: 'DorAI ব্রাউজার এক্সটেনশন Daraz, Cartup ও Othoba-র পণ্যের পাতাতেই দেখায় অন্য দোকানে একই পণ্য, কম দামের বিশ্বস্ত বিক্রেতা আর আগের সর্বনিম্ন দাম।',
    testing: 'এটি এখন পরীক্ষামূলক:',
    source: 'সোর্স থেকে',
    load: 'Chrome বা Edge-এ লোড করুন (Extensions → Developer mode → Load unpacked)।',
  },
  en: {
    phone: 'On your phone',
    installed: 'DorAI is installed. In the Daraz, Cartup or Othoba app, tap Share on a product and choose DorAI to compare it.',
    iphone: 'In Safari, tap Share, then “Add to Home Screen”. To compare a product, copy its link in the store’s app and paste it into the box above.',
    android: 'Install DorAI as an app. Then in the Daraz, Cartup or Othoba app, tap Share on any product and choose DorAI to see it on every store.',
    install: 'Install DorAI',
    menu: 'In Chrome’s menu, choose “Add to Home screen” or “Install app”.',
    computer: 'On a computer',
    extension: 'The DorAI browser extension shows the same product on the other stores, cheaper trusted sellers and the lowest price we’ve seen, right on Daraz, Cartup and Othoba product pages.',
    testing: 'It’s in testing:',
    source: 'from its source',
    load: 'load it into Chrome or Edge (Extensions → Developer mode → Load unpacked).',
  },
}

// The two ways to use DorAI outside this page: installed on a phone, where
// Share in the Daraz, Cartup or Othoba app sends a product here (Android), and the
// browser extension, which shows it on the stores' own product pages.
export default function GetDorAI() {
  const { t, lang } = useLang()
  const c = COPY[lang]
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installed, setInstalled] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches ?? false)
  const iPhone = /iphone|ipad|ipod/i.test(navigator.userAgent)

  useEffect(() => {
    // Chrome and Edge offer installing; the page decides when to ask.
    const offer = (event) => {
      event.preventDefault()
      setInstallPrompt(event)
    }
    const done = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', offer)
    window.addEventListener('appinstalled', done)
    return () => {
      window.removeEventListener('beforeinstallprompt', offer)
      window.removeEventListener('appinstalled', done)
    }
  }, [])

  return (
    <section className="section" id="get" aria-labelledby="get-title">
      <h2 id="get-title">{t.getTitle}</h2>
      <div className="card-grid">
        <div className="card">
          <h3>{c.phone}</h3>
          {installed ? (
            <p>{c.installed}</p>
          ) : iPhone ? (
            <p>{c.iphone}</p>
          ) : (
            <>
              <p>{c.android}</p>
              {installPrompt ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={async () => {
                    installPrompt.prompt()
                    await installPrompt.userChoice.catch(() => null)
                    setInstallPrompt(null)
                  }}
                >
                  {c.install}
                </button>
              ) : (
                <p className="muted">{c.menu}</p>
              )}
            </>
          )}
        </div>
        <div className="card">
          <h3>{c.computer}</h3>
          <p>{c.extension}</p>
          <p className="muted">
            {c.testing}{' '}
            <a href={EXTENSION_SOURCE} target="_blank" rel="noreferrer">
              {c.source}
            </a>{' '}
            {c.load}
          </p>
        </div>
      </div>
    </section>
  )
}
