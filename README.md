# Mehmet Gulumser - Low Cost RAG Website MVP

Bu repo, Mehmet Gülümser için düşük trafikte ücretsiz servislerle çalışacak MVP iskeletini içerir.

## Stack
- Website: Cloudflare Pages (statik)
- Chat API: Cloudflare Workers
- Database: Supabase Postgres
- Retrieval: Postgres Full-Text Search (FTS) (no embeddings)
- LLM: Gemini API
- Scraper/Indexer: Python scriptleri (GitHub Actions ile cron çalıştırılabilir)

## Klasorler
- `infra/supabase/schema.sql`: tablo, vektör index, retrieval RPC
- `services/scraper/scrape_and_store.py`: iki siteden yazı toplama + DB upsert
- `services/indexer/index_articles.py`: chunk + FTS indexleme (`article_chunks_fts`)
- `apps/chat-worker/worker.js`: chatbot endpoint
- `apps/site/`: basit web + chat widget

## Kurulum
1. Supabase projesi ac, SQL Editor'da `infra/supabase/schema.sql` calistir.
2. SQL Editor'da `infra/supabase/migrations/001_fts_chunks.sql` calistir (FTS retrieval icin).
3. SQL Editor'da `infra/supabase/migrations/002_fts_title_boost.sql` calistir.
4. SQL Editor'da `infra/supabase/migrations/003_chat_guards.sql` calistir (rate-limit + butce korumasi).
5. `.env.example` dosyasini `.env` olarak kopyala ve degiskenleri doldur.
6. Python ortami:
   - `python3 -m venv .venv && source .venv/bin/activate`
   - `pip install -r services/scraper/requirements.txt`
   - `pip install -r services/indexer/requirements.txt`
7. Ilk veri hasadi:
   - `python services/scraper/scrape_and_store.py --to-db`
8. RAG indexleme:
   - `python services/indexer/index_articles.py`
9. Worker deploy:
   - `cd apps/chat-worker`
   - `npm i -g wrangler`
   - `wrangler secret put GEMINI_API_KEY`
   - `wrangler secret put SUPABASE_URL`
   - `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
   - `wrangler deploy`
10. `apps/site/chat-widget.js` icindeki `API_URL` degerini worker URL ile guncelle.

## Ucretli API + Guvenlik
- Ucretli Gemini key'e gecmek icin tekrar calistir:
  - `wrangler secret put GEMINI_API_KEY`
  - `wrangler deploy`
- Istismar/kota kontrolu Worker env varlari:
  - `MAX_REQ_PER_MINUTE_PER_IP`
  - `MAX_REQ_PER_DAY`
  - `MAX_REQ_PER_MONTH`
  - `MAX_TOKENS_PER_DAY`
  - `MAX_TOKENS_PER_MONTH`
- Varsayilan degerler `apps/chat-worker/wrangler.toml` icindedir; ihtiyaca gore dusurulebilir.

## Notlar
- Scraper genel/heuristic parser kullanır. İlk çalıştırmadan sonra seçiciler sahaya göre ince ayar ister.
- Düşük trafik için uygun tasarlandı. Trafik artarsa retrieval ve caching katmanı güçlendirilebilir.

## Dokumantasyon
- `docs/RUNBOOK.md`: Mimari, deploy ve operasyon notlari.
