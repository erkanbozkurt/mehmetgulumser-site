-- Chat rate-limit and budget guard tables/functions.

create table if not exists chat_usage_daily (
  usage_date date primary key,
  request_count integer not null default 0,
  prompt_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists chat_usage_monthly (
  usage_month date primary key,
  request_count integer not null default 0,
  prompt_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists chat_ip_minute (
  bucket timestamptz not null,
  client_hash text not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket, client_hash)
);

create index if not exists idx_chat_ip_minute_updated_at on chat_ip_minute(updated_at);

create or replace function enforce_chat_guard(
  p_client_hash text,
  p_max_req_per_minute integer default 6,
  p_max_req_per_day integer default 400,
  p_max_req_per_month integer default 8000,
  p_max_tokens_per_day bigint default 350000,
  p_max_tokens_per_month bigint default 7000000
)
returns table (
  allowed boolean,
  reason text,
  retry_after_seconds integer,
  current_minute_requests integer,
  current_day_requests integer,
  current_month_requests integer,
  current_day_tokens bigint,
  current_month_tokens bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_client text := coalesce(nullif(trim(p_client_hash), ''), 'anon');
  v_bucket timestamptz := date_trunc('minute', v_now);
  v_day date := v_now::date;
  v_month date := date_trunc('month', v_now)::date;
  v_minute_reqs integer := 0;
  v_day_reqs integer := 0;
  v_month_reqs integer := 0;
  v_day_tokens bigint := 0;
  v_month_tokens bigint := 0;
  v_retry integer := 0;
begin
  -- Keep minute-bucket table bounded.
  delete from chat_ip_minute
  where bucket < (v_now - interval '2 days');

  insert into chat_usage_daily (usage_date) values (v_day)
  on conflict (usage_date) do nothing;

  insert into chat_usage_monthly (usage_month) values (v_month)
  on conflict (usage_month) do nothing;

  select d.request_count, d.total_tokens
    into v_day_reqs, v_day_tokens
  from chat_usage_daily d
  where d.usage_date = v_day;

  select m.request_count, m.total_tokens
    into v_month_reqs, v_month_tokens
  from chat_usage_monthly m
  where m.usage_month = v_month;

  select coalesce(i.request_count, 0)
    into v_minute_reqs
  from chat_ip_minute i
  where i.bucket = v_bucket
    and i.client_hash = v_client;

  if v_minute_reqs >= greatest(p_max_req_per_minute, 1) then
    v_retry := greatest(1, 60 - extract(second from v_now)::integer);
    return query
    select false, 'ip_minute_limit', v_retry, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
    return;
  end if;

  if v_day_reqs >= greatest(p_max_req_per_day, 1) then
    v_retry := greatest(1, extract(epoch from ((v_day + interval '1 day') - v_now))::integer);
    return query
    select false, 'daily_request_limit', v_retry, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
    return;
  end if;

  if v_month_reqs >= greatest(p_max_req_per_month, 1) then
    v_retry := greatest(1, extract(epoch from ((v_month + interval '1 month') - v_now))::integer);
    return query
    select false, 'monthly_request_limit', v_retry, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
    return;
  end if;

  if v_day_tokens >= greatest(p_max_tokens_per_day, 1) then
    v_retry := greatest(1, extract(epoch from ((v_day + interval '1 day') - v_now))::integer);
    return query
    select false, 'daily_token_limit', v_retry, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
    return;
  end if;

  if v_month_tokens >= greatest(p_max_tokens_per_month, 1) then
    v_retry := greatest(1, extract(epoch from ((v_month + interval '1 month') - v_now))::integer);
    return query
    select false, 'monthly_token_limit', v_retry, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
    return;
  end if;

  insert into chat_ip_minute (bucket, client_hash, request_count, updated_at)
  values (v_bucket, v_client, 1, v_now)
  on conflict (bucket, client_hash)
  do update set
    request_count = chat_ip_minute.request_count + 1,
    updated_at = excluded.updated_at
  returning request_count into v_minute_reqs;

  update chat_usage_daily d
  set request_count = d.request_count + 1,
      updated_at = v_now
  where d.usage_date = v_day;

  update chat_usage_monthly m
  set request_count = m.request_count + 1,
      updated_at = v_now
  where m.usage_month = v_month;

  select d.request_count, d.total_tokens
    into v_day_reqs, v_day_tokens
  from chat_usage_daily d
  where d.usage_date = v_day;

  select m.request_count, m.total_tokens
    into v_month_reqs, v_month_tokens
  from chat_usage_monthly m
  where m.usage_month = v_month;

  return query
  select true, null::text, 0, v_minute_reqs, v_day_reqs, v_month_reqs, v_day_tokens, v_month_tokens;
end;
$$;

create or replace function record_chat_tokens(
  p_prompt_tokens integer default 0,
  p_output_tokens integer default 0,
  p_total_tokens integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_day date := v_now::date;
  v_month date := date_trunc('month', v_now)::date;
  v_prompt bigint := greatest(coalesce(p_prompt_tokens, 0), 0);
  v_output bigint := greatest(coalesce(p_output_tokens, 0), 0);
  v_total bigint := greatest(coalesce(p_total_tokens, 0), 0);
begin
  if v_total = 0 then
    v_total := v_prompt + v_output;
  end if;

  insert into chat_usage_daily (usage_date, prompt_tokens, output_tokens, total_tokens, updated_at)
  values (v_day, v_prompt, v_output, v_total, v_now)
  on conflict (usage_date) do update set
    prompt_tokens = chat_usage_daily.prompt_tokens + excluded.prompt_tokens,
    output_tokens = chat_usage_daily.output_tokens + excluded.output_tokens,
    total_tokens = chat_usage_daily.total_tokens + excluded.total_tokens,
    updated_at = excluded.updated_at;

  insert into chat_usage_monthly (usage_month, prompt_tokens, output_tokens, total_tokens, updated_at)
  values (v_month, v_prompt, v_output, v_total, v_now)
  on conflict (usage_month) do update set
    prompt_tokens = chat_usage_monthly.prompt_tokens + excluded.prompt_tokens,
    output_tokens = chat_usage_monthly.output_tokens + excluded.output_tokens,
    total_tokens = chat_usage_monthly.total_tokens + excluded.total_tokens,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function enforce_chat_guard(text, integer, integer, integer, bigint, bigint) from public;
revoke all on function record_chat_tokens(integer, integer, integer) from public;

grant execute on function enforce_chat_guard(text, integer, integer, integer, bigint, bigint) to service_role;
grant execute on function record_chat_tokens(integer, integer, integer) to service_role;
