import os

import psycopg
from dotenv import load_dotenv

# Load from repo root when run locally; avoids find_dotenv() edge-cases.
load_dotenv(".env")

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 200


def chunk_text(text: str) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []
    chunks = []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + CHUNK_SIZE, n)
        chunks.append(text[i:end])
        i += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def main():
    db_url = os.getenv("DATABASE_URL")

    if not db_url:
        raise RuntimeError("DATABASE_URL tanımlı değil")

    # Supabase pooler can behave badly with prepared statements; disable them.
    with psycopg.connect(db_url, prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, title, source_url, content_text
                from articles
                where status = 'published'
                order by coalesce(published_at, created_at) desc
                """
            )
            articles = cur.fetchall()

            print(f"[INFO] Indexlenecek yazı: {len(articles)}")

            for article_id, title, source_url, content_text in articles:
                chunks = chunk_text(content_text)
                if not chunks:
                    continue

                cur.execute("delete from article_chunks_fts where article_id = %s", (article_id,))

                for idx, chunk in enumerate(chunks):
                    cur.execute(
                        """
                        insert into article_chunks_fts (
                          article_id, chunk_index, chunk_text
                        ) values (%s,%s,%s)
                        """,
                        (article_id, idx, chunk),
                    )

                print(f"[OK] {title} -> {len(chunks)} chunk")

        conn.commit()


if __name__ == "__main__":
    main()
