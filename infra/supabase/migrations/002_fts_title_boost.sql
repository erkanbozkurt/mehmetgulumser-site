-- Improve FTS retrieval by including article-title matches and boosting them.

alter table articles
  add column if not exists title_tsv tsvector
  generated always as (to_tsvector('turkish', coalesce(title, ''))) stored;

create index if not exists idx_articles_title_tsv on articles using gin (title_tsv);

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
  chunk_candidates as (
    select
      ac.article_id,
      a.title,
      a.source_url,
      ac.chunk_text,
      ts_rank_cd(ac.chunk_tsv, q.tsq) as chunk_score,
      ts_rank_cd(a.title_tsv, q.tsq) as title_score,
      (a.title_tsv @@ q.tsq) as title_match
    from article_chunks_fts ac
    join articles a on a.id = ac.article_id
    cross join q
    where ac.chunk_tsv @@ q.tsq
       or a.title_tsv @@ q.tsq
  ),
  best_chunk_per_article as (
    select distinct on (article_id)
      article_id,
      title,
      source_url,
      chunk_text,
      (
        chunk_score +
        case
          when title_match then greatest(0.60, title_score * 0.50)
          else 0
        end
      )::float as similarity
    from chunk_candidates
    order by article_id, chunk_score desc, title_score desc
  ),
  title_only_articles as (
    select
      a.id as article_id,
      a.title,
      a.source_url,
      left(coalesce(a.content_text, ''), 1400) as chunk_text,
      (0.45 + ts_rank_cd(a.title_tsv, q.tsq))::float as similarity
    from articles a
    cross join q
    where a.title_tsv @@ q.tsq
      and not exists (
        select 1
        from best_chunk_per_article b
        where b.article_id = a.id
      )
  ),
  combined as (
    select * from best_chunk_per_article
    union all
    select * from title_only_articles
  )
  select
    c.article_id,
    c.title,
    c.source_url,
    c.chunk_text,
    c.similarity
  from combined c
  order by c.similarity desc, c.article_id desc
  limit match_count;
$$;
