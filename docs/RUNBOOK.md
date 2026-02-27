# MehmetGulumser.com Runbook (Ops + Tech Notes)

Tarih: 2026-02-27

Bu dokuman, Mehmet Gulumser web sitesi ve chatbot sisteminin mimarisini, kullanilan teknolojileri, kurulum/deploy adimlarini ve guncelleme operasyonlarini tek yerde toplar.

## 1) Amac
- Mehmet Gulumser'e ait yazilari iki kaynaktan (Ajans Bakircay + Gazete Yenigun) otomatik toplayip tek arsivde birlestirmek.
- Bu arsivi sitede gostermek.
- Arsiv uzerinden kaynakli cevap veren bir chatbot saglamak.

## 2) Mimari Ozet
Bilesenler:
- Scraper: yazar sayfalarini gezer, yazilari parse eder, DB'ye yazar.
- Indexer: yazilari chunk'lara ayirir, arama icin Postgres Full-Text Search (FTS) tablosuna yazar.
- Chat API: Cloudflare Worker; Supabase RPC ile ilgili chunk'lari alir, Gemini ile cevap uretir.
- Website: Cloudflare Pages; statik HTML/CSS, sag altta chat widget.

Neden embedding yerine FTS:
- Gemini API key'inde embedding modelleri (embedContent) erisimi desteklenmedigi icin RAG retrieval embedding ile yapilamadi.
- Ucretsiz/hafif hedefi icin Postgres FTS, bu proje olceginde yeterli.

## 3) Kullanilan Teknolojiler
- Source scraping: Python + `requests` + `beautifulsoup4`
- Database: Supabase Postgres
- Retrieval: Postgres FTS (`to_tsvector('turkish', ...)`, `websearch_to_tsquery`)
- LLM: Google Gemini (`gemini-2.5-flash`)
- Chat API runtime: Cloudflare Workers (`wrangler` ile deploy)
- Website hosting: Cloudflare Pages (`wrangler pages deploy` ile deploy)
- Otomatik guncelleme: GitHub Actions cron (`.github/workflows/update-content.yml`)

## 4) Repo Yapisi
- `infra/supabase/schema.sql`: temel tablolar (authors, articles, images, eski embedding tablosu)
- `infra/supabase/migrations/001_fts_chunks.sql`: FTS chunk tablosu + RPC
- `services/scraper/scrape_and_store.py`: yazilari scrape edip JSON + DB upsert
- `services/indexer/index_articles.py`: chunk + `article_chunks_fts` rebuild
- `apps/chat-worker/worker.js`: chatbot API (retrieve + Gemini answer)
- `apps/chat-worker/wrangler.toml`: worker konfigurasyonu
- `apps/site/*`: statik site + chat widget

## 5) Veritabani Semasi (Ozet)
Temel:
- `authors`: yazar kaydi
- `articles`: yazilar (source_url unique)
- `article_images`: yazilara bagli gorseller

FTS:
- `article_chunks_fts`: (article_id, chunk_index, chunk_text, chunk_tsv)
- `match_article_chunks_fts(query_text, match_count)`: ilgili chunk'lari rank ile doner

Not:
- `article_chunks` (embedding) tablosu ilk tasarimdan kalmis olabilir, aktif retrieval FTS'tir.

## 6) Kurulum (Lokal)
Gerekenler:
- Python 3.x
- `pip`

`.env` dosyasi (repo root):
- `DATABASE_URL=...` (Supabase Postgres URI, tercihen pooler)
- `GEMINI_API_KEY=...`

Scraper + indexer paketleri:
- `python3 -m pip install --user -r services/scraper/requirements.txt`
- `python3 -m pip install --user -r services/indexer/requirements.txt`

## 7) Ilk Veri Yukleme
1) DB semasi:
- Supabase SQL Editor'da `infra/supabase/schema.sql` calistir
- Supabase SQL Editor'da `infra/supabase/migrations/001_fts_chunks.sql` calistir

2) Yazilari cek ve DB'ye yaz:
- `python3 services/scraper/scrape_and_store.py --to-db --out data/raw/articles.json`

3) FTS index olustur:
- `python3 services/indexer/index_articles.py`

## 8) Scraper Notlari
- Listing'ler:
  - `https://www.ajansbakircay.com/profil/35/mehmet-gulumser`
  - `https://www.gazeteyenigun.com.tr/yazar/mehmet-gulumser` (+ sayfa numarali pagination)
- Gazete Yenigun icin `/yazar/mehmet-gulumser/2` ... gibi sayfalari da gezer.
- Ajans Bakircay icin `-makale,<id>.html` pattern'i ile filtrelenir.

## 9) Deploy
### 9.1) Cloudflare Worker (Chat API)
Dizin:
- `apps/chat-worker`

Secret'lar:
- `GEMINI_API_KEY`
- `SUPABASE_URL` (https://<project>.supabase.co)
- `SUPABASE_SERVICE_ROLE_KEY`

Komutlar:
- `wrangler login`
- `wrangler secret put GEMINI_API_KEY`
- `wrangler secret put SUPABASE_URL`
- `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
- `wrangler deploy`

Not:
- Worker retrieval FTS RPC kullanir.
- LLM hatasinda kaynak listesini fallback olarak dondurur.

### 9.2) Cloudflare Pages (Website)
Dizin:
- `apps/site`

Deploy:
- `wrangler pages deploy apps/site --project-name mehmetgulumser-site`

## 10) Domain / DNS
- `mehmetgulumser.com` Cloudflare Pages Custom Domain olarak baglandi.
- `www -> root` redirect Cloudflare redirect rule ile yapildi.

DNS propagation notu:
- Yerel (Wi-Fi) DNS cache nedeniyle bir sure eski "under construction" sayfasi gorulebilir.
- Mobil veri ile dogru site gorunuyorsa konfigurasyon dogrudur; cache zamanla duzelir.

## 11) Otomatik Guncelleme (GitHub Actions)
Workflow:
- `.github/workflows/update-content.yml`

Gereken GitHub Secrets:
- `DATABASE_URL`
- `GEMINI_API_KEY`

Akis:
- Scrape + upsert
- Index rebuild

## 12) Operasyon Komutlari
Yazilari yenile:
- `python3 services/scraper/scrape_and_store.py --to-db`

Index'i bastan kur:
- `python3 services/indexer/index_articles.py`

DB sayim kontrol (lokal):
- `python3 - <<'PY'
import os, psycopg
from dotenv import load_dotenv
load_dotenv('.env')
with psycopg.connect(os.environ['DATABASE_URL'], prepare_threshold=None) as c:
  with c.cursor() as cur:
    for t in ['articles','article_images','article_chunks_fts']:
      cur.execute(f'select count(*) from {t}')
      print(t, cur.fetchone()[0])
PY`

## 13) Bilinen Limitler / Ileride Iyilestirme
- Retrieval FTS oldugu icin anlamsal eslesme embedding kadar iyi olmayabilir.
- Yazilar sayfasi su an statik ornek liste; DB'den dinamik listeleme istenirse (Pages Functions / Worker API) eklenebilir.
- Gorseller su an sadece URL olarak saklaniyor; ileride R2/Supabase Storage'a aynalanabilir.
