create extension if not exists vector;

create table if not exists authors (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists articles (
  id bigserial primary key,
  author_id bigint not null references authors(id) on delete cascade,
  source_site text not null,
  source_url text not null unique,
  title text not null,
  slug text not null,
  published_at timestamptz,
  excerpt text,
  content_html text,
  content_text text not null,
  status text not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_articles_author_id on articles(author_id);
create index if not exists idx_articles_published_at on articles(published_at desc);
create unique index if not exists idx_articles_slug_source on articles(source_site, slug);

create table if not exists article_images (
  id bigserial primary key,
  article_id bigint not null references articles(id) on delete cascade,
  image_url text not null,
  alt_text text,
  ord int not null default 0,
  created_at timestamptz not null default now(),
  unique (article_id, image_url)
);

create table if not exists article_chunks (
  id bigserial primary key,
  article_id bigint not null references articles(id) on delete cascade,
  chunk_index int not null,
  chunk_text text not null,
  embedding vector(768) not null,
  token_estimate int,
  created_at timestamptz not null default now(),
  unique (article_id, chunk_index)
);

create index if not exists idx_article_chunks_article_id on article_chunks(article_id);
create index if not exists idx_article_chunks_embedding on article_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create or replace function match_article_chunks(
  query_embedding vector(768),
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
  select
    ac.article_id,
    a.title,
    a.source_url,
    ac.chunk_text,
    1 - (ac.embedding <=> query_embedding) as similarity
  from article_chunks ac
  join articles a on a.id = ac.article_id
  order by ac.embedding <=> query_embedding
  limit match_count;
$$;
