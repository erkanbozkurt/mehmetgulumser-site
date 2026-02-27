import os
from typing import Iterable

import psycopg
from dotenv import load_dotenv
from google import genai

load_dotenv()

EMBED_MODEL = "text-embedding-004"
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


def embedding_to_pgvector(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{v:.8f}" for v in values) + "]"


def main():
    db_url = os.getenv("DATABASE_URL")
    gemini_key = os.getenv("GEMINI_API_KEY")

    if not db_url:
        raise RuntimeError("DATABASE_URL tanımlı değil")
    if not gemini_key:
        raise RuntimeError("GEMINI_API_KEY tanımlı değil")

    client = genai.Client(api_key=gemini_key)

    with psycopg.connect(db_url) as conn:
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

                cur.execute("delete from article_chunks where article_id = %s", (article_id,))

                for idx, chunk in enumerate(chunks):
                    emb = client.models.embed_content(
                        model=EMBED_MODEL,
                        contents=chunk,
                    )
                    vector = emb.embeddings[0].values
                    vector_lit = embedding_to_pgvector(vector)

                    cur.execute(
                        """
                        insert into article_chunks (
                          article_id, chunk_index, chunk_text, embedding, token_estimate
                        ) values (%s,%s,%s,%s::vector,%s)
                        """,
                        (article_id, idx, chunk, vector_lit, max(1, len(chunk) // 4)),
                    )

                print(f"[OK] {title} -> {len(chunks)} chunk")

        conn.commit()


if __name__ == "__main__":
    main()
