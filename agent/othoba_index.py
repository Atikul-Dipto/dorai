"""A search index of Othoba's catalogue, so the Cloudflare agent can find a
product on Othoba at all (the same layout as cartup_index.py, in othoba_*
tables).

Why it's built this way (checked 2026-11-02):
- robots.txt disallows /search? and /category/products/ (the page's product
  loader), and the site's Typesense search key is deliberately obscured in
  the page (`decodeApiKey(...)`), so neither search is used.
- sitemap.xml is empty.
- Category pages are allowed and list 40 products each in their HTML
  (names and addresses; prices come later from the page's scripts), with
  ?pagenumber=N for the next 40. Product pages are allowed and carry
  schema.org Product JSON-LD with the live price, stock and seller, which
  the agent reads per question (worker/othoba.ts).

So this walks the categories in the order Othoba's menu lists them, one page
a second. A parent category holds its subcategories' products, so a category
is left after 3 pages in a row with nothing new (subcategories cost about
three requests each) or at a page with no products at all. The first crawl
(2026-11-02) left a category at its first page with nothing new and missed
most of the electronics (Awei T50 earbuds, all of "audio-3"): a category's
first page often repeats products seen elsewhere. A page that should have
products but comes back empty is asked for once more after a pause. Every
crawl keeps what earlier ones found. The product name is in the address:
    /fresh-fortified-soyebean-oil-5ltr-2  ->  "fresh fortified soyebean oil 5ltr 2"

    .venv\\Scripts\\python.exe -m agent --index-othoba            # crawl + upload (~1 hour)
    .venv\\Scripts\\python.exe -m agent --index-othoba --dry-run  # crawl + report only
"""

from __future__ import annotations

import json
import re
import time

import requests

from .cartup_index import build_postings, statements, upload
from .d1 import PROJECT

DATA = PROJECT / "data" / "othoba"
BASE = "https://othoba.com"
START = "/food-grocery"  # any category page carries the full menu
UA = "Mozilla/5.0 (compatible; DorAIIndexer/1.0; +https://dorai-bd.pages.dev/)"
PAUSE = 1.0
MAX_PAGES = 400  # per category, a safety stop
STALE_PAGES = 3  # pages in a row with nothing new before a category is left

CARD_RE = re.compile(r'data-productid="(\d+)"[\s\S]*?<a href="/([a-z0-9][a-z0-9-]*)"')
LINK_RE = re.compile(r'href="/([a-z0-9][a-z0-9-]*)"')
# Site pages in the menu that aren't categories, and everything robots.txt disallows.
NOT_CATEGORIES = {
    "wishlist", "contactus", "login", "register", "cart", "sitemap", "super-offers", "popular-item", "seller-info",
    "passwordrecovery", "compareproducts", "clearcomparelist", "checkout", "onepagecheckout", "customer", "order",
    "orderdetails", "privatemessages", "sendpm", "deletepm", "viewpm", "recentlyviewedproducts", "storeclosed",
    "subscribenewsletter", "changecurrency", "changelanguage", "changetaxtype", "admin", "install", "boards",
}


def fetch(session: requests.Session, path: str) -> str:
    for attempt in range(3):
        try:
            response = session.get(BASE + path, headers={"User-Agent": UA}, timeout=60)
            if response.status_code == 404:
                return ""
            response.raise_for_status()
            return response.text
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(10 * (attempt + 1))
    return ""


def crawl(log=print) -> list[str]:
    """Every product address found in Othoba's categories, in crawl order."""
    session = requests.Session()
    first = fetch(session, START)
    cards = set(slug for _, slug in CARD_RE.findall(first))
    categories = [s for s in dict.fromkeys(LINK_RE.findall(first)) if s not in cards and s not in NOT_CATEGORIES]
    slugs: dict[str, None] = {}
    seen_ids: set[str] = set()
    requests_made = 1
    for n, category in enumerate(categories, start=1):
        added = stale = 0
        previous = None  # how many products the last page had
        for page in range(1, MAX_PAGES + 1):
            path = f"/{category}" + (f"?pagenumber={page}" if page > 1 else "")
            html = fetch(session, path)
            requests_made += 1
            time.sleep(PAUSE)
            found = CARD_RE.findall(html)
            if not found and (previous is None or previous >= 30):
                # Expected products and got none: a hiccup, not the end. Once more, after a pause.
                time.sleep(30)
                found = CARD_RE.findall(fetch(session, path))
                requests_made += 1
            if not found:
                break  # the end of the category
            new = [(pid, slug) for pid, slug in found if pid not in seen_ids]
            for pid, slug in new:
                seen_ids.add(pid)
                slugs[slug] = None
            added += len(new)
            stale = 0 if new else stale + 1
            if stale >= STALE_PAGES:
                break  # its products came with a parent category
            previous = len(found)
        log(f"{n}/{len(categories)} {category}: +{added} (total {len(slugs)}, {requests_made} requests)")
    return list(slugs)


def run(push: bool = True) -> dict:
    t0 = time.time()
    DATA.mkdir(parents=True, exist_ok=True)
    saved = DATA / "slugs.json"
    earlier = json.loads(saved.read_text(encoding="utf-8")) if saved.exists() else []
    # This crawl's finds first, then anything earlier crawls found that this one didn't.
    slugs = list(dict.fromkeys([*crawl(), *earlier]))
    saved.write_text(json.dumps(slugs), encoding="utf-8")
    postings, common = build_postings(slugs)
    stmts = statements(slugs, postings, common, prefix="othoba")
    stats = {"products": len(slugs), "tokens": len(postings), "too_common": len(common), "rows": len(stmts), "sql_mb": round(sum(map(len, stmts)) / 1e6, 1)}
    if push:
        stats["uploads"] = upload(stmts, prefix="othoba")
    stats["seconds"] = round(time.time() - t0)
    return stats


def upload_saved() -> dict:
    """Upload the last crawl (data/othoba/slugs.json) without crawling again."""
    slugs = json.loads((DATA / "slugs.json").read_text(encoding="utf-8"))
    postings, common = build_postings(slugs)
    stmts = statements(slugs, postings, common, prefix="othoba")
    return {"products": len(slugs), "uploads": upload(stmts, prefix="othoba")}
