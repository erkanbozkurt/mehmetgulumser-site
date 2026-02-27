# Mehmet Gulumser - Low Cost RAG Website MVP

Bu repo, Mehmet Gülümser için düşük trafikte ücretsiz servislerle çalışacak MVP iskeletini içerir.

## Stack
- Website: Cloudflare Pages (statik)
- Chat API: Cloudflare Workers
- Database + Vector: Supabase Postgres + pgvector
- LLM + Embedding: Gemini API
- Scraper/Indexer: Python scriptleri (GitHub Actions ile cron çalıştırılabilir)

## Klasorler
- `infra/supabase/schema.sql`: tablo, vektör index, retrieval RPC
- `services/scraper/scrape_and_store.py`: iki siteden yazı toplama + DB upsert
- `services/indexer/index_articles.py`: chunk + embedding + `article_chunks` indexleme
- `apps/chat-worker/worker.js`: chatbot endpoint
- `apps/site/`: basit web + chat widget

## Kurulum
1. Supabase projesi ac, SQL Editor'da `infra/supabase/schema.sql` calistir.
2. `.env.example` dosyasini `.env` olarak kopyala ve degiskenleri doldur.
3. Python ortamı:
   - `python3 -m venv .venv && source .venv/bin/activate`
   - `pip install -r services/scraper/requirements.txt`
   - `pip install -r services/indexer/requirements.txt`
4. İlk veri hasadı:
   - `python services/scraper/scrape_and_store.py --to-db`
5. RAG indexleme:
   - `python services/indexer/index_articles.py`
6. Worker deploy:
   - `cd apps/chat-worker`
   - `npm i -g wrangler`
   - `wrangler secret put GEMINI_API_KEY`
   - `wrangler secret put SUPABASE_URL`
   - `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
   - `wrangler deploy`
7. `apps/site/chat-widget.js` içindeki `API_URL` değerini worker URL ile güncelle.

## Notlar
- Scraper genel/heuristic parser kullanır. İlk çalıştırmadan sonra seçiciler sahaya göre ince ayar ister.
- Düşük trafik için uygun tasarlandı. Trafik artarsa retrieval ve caching katmanı güçlendirilebilir.
