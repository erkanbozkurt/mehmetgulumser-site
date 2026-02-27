-- FTS-based retrieval (no embeddings needed).

create table if not exists article_chunks_fts (
  id bigserial primary key,
  article_id bigint not null references articles(id) on delete cascade,
  chunk_index int not null,
  chunk_text text not null,
  chunk_tsv tsvector generated always as (to_tsvector('turkish', coalesce(chunk_text, ''))) stored,
  created_at timestamptz not null default now(),
  unique (article_id, chunk_index)
);

create index if not exists idx_article_chunks_fts_article_id on article_chunks_fts(article_id);
create index if not exists idx_article_chunks_fts_tsv on article_chunks_fts using gin (chunk_tsv);

create or replace function match_article_chunks_fts(
  query_text text,
  match_count int default 8
)
returns table (
  article_id bigint,
  title text,
  source_url text,
  chunk_text text,
  similarity float
)
language sql
stable
as $$
  with q as (
    select websearch_to_tsquery('turkish', query_text) as tsq
  ),
  ranked as (
    select
      ac.article_id,
      a.title,
      a.source_url,
      ac.chunk_text,
      ts_rank_cd(ac.chunk_tsv, q.tsq) as similarity
    from article_chunks_fts ac
    join articles a on a.id = ac.article_id
    cross join q
    where ac.chunk_tsv @@ q.tsq
  ),
  best_per_article as (
    select distinct on (article_id)
      article_id, title, source_url, chunk_text, similarity
    from ranked
    order by article_id, similarity desc
  )
  select *
  from best_per_article
  order by similarity desc
  limit match_count;
$$;
