import argparse
import json
import os
import re
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse

import psycopg
import requests
from bs4 import BeautifulSoup
from dateutil import parser as dtparser
from dotenv import load_dotenv
from slugify import slugify

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; MehmetGulumserBot/1.0; +https://example.com)",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
}

LISTING_URLS = [
    "https://www.ajansbakircay.com/profil/35/mehmet-gulumser",
    "https://www.gazeteyenigun.com.tr/yazar/mehmet-gulumser",
]

AJANS_EXPECTED_PROFILE_PATH = "/profil/35/mehmet-gulumser"


@dataclass
class Article:
    source_site: str
    source_url: str
    title: str
    slug: str
    published_at: Optional[str]
    excerpt: Optional[str]
    content_html: str
    content_text: str
    images: list[str]


def get_html(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.text


def normalize_url(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}{p.path}".rstrip("/")


def likely_article_url(url: str, listing_url: str) -> bool:
    p = urlparse(url)
    path = p.path.lower()
    if not path or path in {"/", ""}:
        return False

    host = p.netloc.lower()
    if "ajansbakircay.com" in host:
        return bool(re.search(r"-makale,\d+\.html$", path))

    if "gazeteyenigun.com.tr" in host:
        return path.startswith("/makale/") and "/mehmet-gulumser/" in path

    blocked = ["/profil", "/yazar", "/kategori", "/etiket", "/arsiv", "/iletisim"]
    return not any(path.startswith(x) for x in blocked)


def find_next_pages(soup: BeautifulSoup, base_url: str, listing_url: str) -> set[str]:
    urls = set()
    listing_path = urlparse(listing_url).path.rstrip("/")
    for a in soup.select("a[href]"):
        txt = (a.get_text(" ", strip=True) or "").lower()
        href = a.get("href", "")
        full = normalize_url(urljoin(base_url, href))
        full_path = urlparse(full).path.rstrip("/")
        if listing_path and not full_path.startswith(listing_path):
            continue
        # Numeric pagination like /yazar/mehmet-gulumser/2
        if listing_path and re.fullmatch(re.escape(listing_path) + r"/\d+", full_path):
            urls.add(full)
            continue
        if any(k in txt for k in ["sonraki", "next", ">", "ileri", "devam"]):
            urls.add(full)
        if re.search(r"[?&](page|sayfa|p)=\d+", href, flags=re.I):
            urls.add(full)
    return urls


def extract_article_links(soup: BeautifulSoup, base_url: str, listing_url: str) -> set[str]:
    found = set()
    base_host = urlparse(base_url).netloc
    anchors = soup.select("a[href]")
    if "ajansbakircay.com" in base_host and AJANS_EXPECTED_PROFILE_PATH in listing_url:
        scoped = soup.select(".show_more_views .show_more_item a[href]")
        if scoped:
            anchors = scoped

    for a in anchors:
        href = a.get("href", "")
        full = normalize_url(urljoin(base_url, href))
        if urlparse(full).netloc != base_host:
            continue
        if likely_article_url(full, listing_url):
            found.add(full)
    return found


def crawl_listing(start_url: str, max_pages: int = 50) -> set[str]:
    visited = set()
    queue = [start_url]
    links = set()

    while queue and len(visited) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue

        try:
            html = get_html(url)
        except Exception as e:
            print(f"[WARN] Liste sayfası alınamadı: {url} -> {e}")
            visited.add(url)
            continue

        soup = BeautifulSoup(html, "html.parser")
        visited.add(url)
        links.update(extract_article_links(soup, url, start_url))

        for nxt in find_next_pages(soup, url, start_url):
            if nxt not in visited and nxt not in queue:
                queue.append(nxt)

        time.sleep(0.2)

    return links


def clean_text(raw: str) -> str:
    text = re.sub(r"\s+", " ", raw).strip()
    return text


def parse_date(soup: BeautifulSoup) -> Optional[str]:
    # Prefer machine-readable metadata to avoid parsing page clock widgets (HH:MM) as "today".
    candidates = []

    meta_selectors = [
        "meta[name='datePublished']",
        "meta[name='dateModified']",
        "meta[property='article:published_time']",
        "meta[property='article:modified_time']",
        "meta[itemprop='datePublished']",
        "meta[itemprop='dateModified']",
        "meta[name='pubdate']",
    ]
    for sel in meta_selectors:
        for m in soup.select(sel):
            content = (m.get("content") or "").strip()
            if content:
                candidates.append(content)

    for t in soup.select("time[datetime]"):
        dt = (t.get("datetime") or "").strip()
        if dt:
            candidates.append(dt)

    # Fallback to visible date strings (ignore plain clock times like "20:36")
    for sel in [".date", ".tarih", ".post-date", ".publish-date", "[itemprop='datePublished']"]:
        for n in soup.select(sel):
            txt = (n.get_text(" ", strip=True) or "").strip()
            if txt:
                candidates.append(txt)

    seen = set()
    for c in candidates:
        if not c or c in seen:
            continue
        seen.add(c)
        if re.fullmatch(r"\\d{1,2}:\\d{2}(:\\d{2})?", c):
            continue
        try:
            d = dtparser.parse(c, dayfirst=True, fuzzy=True)
            return d.isoformat()
        except Exception:
            continue
    return None


def best_content_node(soup: BeautifulSoup):
    priority_selectors = [
        "article",
        ".article-content",
        ".post-content",
        ".yazi-icerik",
        ".content",
        "main",
    ]
    for sel in priority_selectors:
        n = soup.select_one(sel)
        if n and len(n.get_text(" ", strip=True)) > 300:
            return n

    best = None
    best_len = 0
    for n in soup.select("div,section"):
        t = n.get_text(" ", strip=True)
        if len(t) > best_len:
            best_len = len(t)
            best = n
    return best


def prune_noise(node):
    noise_selectors = [
        "script",
        "style",
        "noscript",
        "iframe",
        "form",
        ".social",
        ".share",
        ".sidebar",
        ".comments",
        ".comment",
        ".related",
        ".reklam",
        ".advert",
        ".ads",
        ".banner",
        "nav",
        "footer",
    ]
    for sel in noise_selectors:
        for junk in node.select(sel):
            junk.decompose()


def is_content_image(url: str) -> bool:
    low = url.lower()
    if low.endswith(".svg"):
        return False
    blocked = [
        "logo",
        "icon",
        "avatar",
        "sprite",
        "banner",
        "reklam",
        "ads",
        "facebook",
        "twitter",
        "instagram",
        "whatsapp",
        "pixel",
        "analytics",
        "/images/sayfalar/",
        "/tema/",
        "/theme/",
        "/assets/",
    ]
    return not any(k in low for k in blocked)


def image_score(url: str) -> int:
    low = url.lower()
    score = 0
    if any(k in low for k in ["upload", "haber", "makale", "news", "yazi"]):
        score += 2
    if re.search(r"/20\d{2}/\d{1,2}/", low):
        score += 1
    if any(k in low for k in ["thumb", "small", "icon"]):
        score -= 2
    return score


def is_expected_ajans_author(soup: BeautifulSoup) -> bool:
    expected = AJANS_EXPECTED_PROFILE_PATH

    for a in soup.select("a[href]"):
        txt = (a.get_text(" ", strip=True) or "").lower()
        if "tüm makaleleri" in txt or "tum makaleleri" in txt:
            href = normalize_url(urljoin("https://www.ajansbakircay.com", a.get("href", "")))
            path = urlparse(href).path.rstrip("/")
            return path == expected

    # Fallback if "Tüm Makaleleri" button is missing.
    hrefs = {
        urlparse(normalize_url(urljoin("https://www.ajansbakircay.com", a.get("href", "")))).path.rstrip("/")
        for a in soup.select("a[href*='/profil/']")
    }
    return expected in hrefs


def parse_article(url: str) -> Optional[Article]:
    try:
        html = get_html(url)
    except Exception as e:
        print(f"[WARN] Yazı sayfası alınamadı: {url} -> {e}")
        return None

    soup = BeautifulSoup(html, "html.parser")
    host = urlparse(url).netloc.lower()
    if "ajansbakircay.com" in host and not is_expected_ajans_author(soup):
        print(f"[SKIP] Farklı yazara ait Ajans yazısı atlandı: {url}")
        return None

    title = ""
    if soup.title:
        title = soup.title.get_text(" ", strip=True)
    h1 = soup.select_one("h1")
    if h1:
        title = h1.get_text(" ", strip=True)

    if not title:
        return None

    node = best_content_node(soup)
    if not node:
        return None

    prune_noise(node)

    paragraphs = [clean_text(p.get_text(" ", strip=True)) for p in node.select("p")]
    paragraphs = [p for p in paragraphs if p and len(p) > 20]

    content_text = "\n\n".join(paragraphs) if paragraphs else clean_text(node.get_text(" ", strip=True))
    if len(content_text) < 300:
        return None

    images = []
    for img in node.select("img[src]"):
        src = urljoin(url, img.get("src", ""))
        if src and is_content_image(src):
            images.append(src)
    images = list(dict.fromkeys(images))
    images = sorted(images, key=image_score, reverse=True)[:12]

    source_site = urlparse(url).netloc
    published_at = parse_date(soup)
    excerpt = content_text[:220] + "..." if len(content_text) > 220 else content_text

    return Article(
        source_site=source_site,
        source_url=normalize_url(url),
        title=title,
        slug=slugify(title, lowercase=True),
        published_at=published_at,
        excerpt=excerpt,
        content_html=str(node),
        content_text=content_text,
        images=images,
    )


def save_json(path: str, articles: list[Article]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = [asdict(a) for a in articles]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def upsert_supabase(articles: Iterable[Article], db_url: str, sync_sources: bool = False):
    if not db_url:
        raise RuntimeError("DATABASE_URL boş. Supabase upsert için DATABASE_URL verin.")

    # Supabase pooler can behave badly with prepared statements; disable them.
    with psycopg.connect(db_url, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into authors (slug, name)
                values ('mehmet-gulumser', 'Mehmet Gülümser')
                on conflict (slug) do update set updated_at = now()
                returning id
                """
            )
            author_id = cur.fetchone()[0]

            for a in articles:
                cur.execute(
                    """
                    insert into articles (
                      author_id, source_site, source_url, title, slug, published_at,
                      excerpt, content_html, content_text
                    ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    on conflict (source_url)
                    do update set
                      title = excluded.title,
                      slug = excluded.slug,
                      published_at = coalesce(excluded.published_at, articles.published_at),
                      excerpt = excluded.excerpt,
                      content_html = excluded.content_html,
                      content_text = excluded.content_text,
                      updated_at = now()
                    returning id
                    """,
                    (
                        author_id,
                        a.source_site,
                        a.source_url,
                        a.title,
                        a.slug,
                        datetime.fromisoformat(a.published_at) if a.published_at else None,
                        a.excerpt,
                        a.content_html,
                        a.content_text,
                    ),
                )
                article_id = cur.fetchone()[0]

                cur.execute("delete from article_images where article_id = %s", (article_id,))
                for idx, image_url in enumerate(a.images):
                    cur.execute(
                        """
                        insert into article_images (article_id, image_url, ord)
                        values (%s,%s,%s)
                        on conflict (article_id, image_url) do nothing
                        """,
                        (article_id, image_url, idx),
                    )

            if sync_sources:
                source_map: dict[str, set[str]] = {}
                for a in articles:
                    source_map.setdefault(a.source_site, set()).add(a.source_url)

                for source_site, urls in source_map.items():
                    if not urls:
                        continue
                    cur.execute(
                        """
                        delete from articles
                        where author_id = %s
                          and source_site = %s
                          and not (source_url = any(%s))
                        """,
                        (author_id, source_site, list(urls)),
                    )
                    if cur.rowcount:
                        print(f"[SYNC] {source_site} için {cur.rowcount} eski kayıt silindi.")
        conn.commit()


def main():
    # Allow running locally without exporting env vars manually.
    load_dotenv()

    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="data/raw/articles.json")
    parser.add_argument("--max-pages", type=int, default=50)
    parser.add_argument("--to-db", action="store_true")
    parser.add_argument("--sync-db", action="store_true", help="DB'de bu kaynaklara ait eski/yanlış kayıtları siler.")
    args = parser.parse_args()

    all_links = set()
    for listing in LISTING_URLS:
        print(f"[INFO] Taranıyor: {listing}")
        all_links.update(crawl_listing(listing, max_pages=args.max_pages))

    print(f"[INFO] Toplam aday link: {len(all_links)}")

    articles = []
    for i, link in enumerate(sorted(all_links), start=1):
        print(f"[INFO] ({i}/{len(all_links)}) Ayrıştırılıyor: {link}")
        article = parse_article(link)
        if article:
            articles.append(article)
        time.sleep(0.1)

    dedup = {a.source_url: a for a in articles}
    final_articles = list(dedup.values())
    print(f"[INFO] Toplam yazı: {len(final_articles)}")

    save_json(args.out, final_articles)
    print(f"[OK] JSON yazıldı: {args.out}")

    if args.to_db:
        db_url = os.getenv("DATABASE_URL", "")
        upsert_supabase(final_articles, db_url, sync_sources=args.sync_db)
        print("[OK] Supabase upsert tamamlandı.")


if __name__ == "__main__":
    main()
