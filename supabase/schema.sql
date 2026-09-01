-- Narrative Scanner — Supabase-schema
-- Kör i Supabase SQL-editorn (eget projekt, separat från coin-agent).

create table if not exists signals (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null,
  source text not null,
  title text not null,
  url text,
  score numeric,
  published_at timestamptz,
  extra jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists narratives (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null,
  narrative text not null,
  ticker_suggestion text,
  name_suggestion text,
  angle text,
  why_now text,
  score int,
  crowdedness text check (crowdedness in ('none','early','crowded')),
  sources jsonb default '[]'::jsonb,
  category text,
  -- fylls i av feedback-loopen (v3):
  launched boolean default false,
  outcome_mcap_24h numeric,
  outcome_mcap_7d numeric,
  created_at timestamptz default now()
);

-- Facit-tabellen: coins som BEVISAT funkat (auto-ifylld av v3 + manuellt av dig).
create table if not exists proven_coins (
  id bigint generated always as identity primary key,
  ticker text not null,
  name text,
  chain text default 'solana',
  token_address text,
  narrative text not null,
  category text,               -- animal-viral, ai-release, breaking-news, celebrity, ...
  launched_at timestamptz,
  peak_mcap_usd numeric,
  time_to_peak_hours numeric,  -- hur snabbt stängde fönstret?
  source_platform text,        -- var föddes narrativet? tiktok/x/news/reddit
  notes text,                  -- fritext: varför funkade den?
  source_message text,         -- exakt Discord-paste från #proven
  tweet_text text,             -- exakt X-inlägg, verbatim
  created_at timestamptz default now()
);

create table if not exists daily_briefs (
  id bigint generated always as identity primary key,
  brief_date date not null unique,
  candidate_count int,
  top_score int,
  sent_to_discord boolean default false,
  created_at timestamptz default now()
);

-- ===== GitHub-scannern (v1-fokus) =====

-- Watchlist: "org" eller "org/repo". Fylls via #watchlist i Discord.
create table if not exists watch_repos (
  id bigint generated always as identity primary key,
  target text not null unique,
  added_by text,
  active boolean default true,
  deep_scanned_at timestamptz,
  created_at timestamptz default now()
);

-- Sök-lexikonet: inlärda termer (seed-termerna ligger i koden).
create table if not exists lexicon (
  id bigint generated always as identity primary key,
  term text not null unique,
  learned_from text, -- vilken proven coin lärde oss detta ($MYC etc)
  created_at timestamptz default now()
);

-- Fynd från scannern (hot + maybe).
create table if not exists findings (
  id bigint generated always as identity primary key,
  repo text not null,
  path text,
  line_number int,
  excerpt text,
  url text,
  egg_name text,
  ticker_suggestion text,
  tweet_draft text,
  reasoning text,
  verdict text check (verdict in ('hot','maybe')),
  crowdedness_matches int,
  queued_for_morning boolean default false, -- nattfynd som väntar på morgonbriefen
  launched boolean default false,           -- fylls i när Kevin agerat (framtida uppföljning)
  created_at timestamptz default now()
);

-- Nyckel/värde-state: senaste körning, senaste lästa Discord-meddelande per kanal, djupscan-flaggor.
create table if not exists scan_state (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- Befintliga projekt: nya kolumner (idempotent).
alter table proven_coins add column if not exists source_message text;
alter table proven_coins add column if not exists tweet_text text;

-- Fingerprint = repo|path|lower(egg_name). Unikt så samma gem inte alertas två gånger.
alter table findings add column if not exists fingerprint text;
create unique index if not exists idx_findings_fingerprint on findings (fingerprint);

create index if not exists idx_findings_created on findings (created_at);
create index if not exists idx_signals_ran_at on signals (ran_at);
create index if not exists idx_narratives_ran_at on narratives (ran_at);
create index if not exists idx_proven_category on proven_coins (category);

-- Förlustfri GitHub-kö: discovery-cursorn flyttas först när commits/filer är
-- varaktigt köade. Arbete som avbryts av timeout eller budget ligger kvar.
create table if not exists github_repo_state (
  repo text primary key,
  last_discovered_sha text,
  baseline_sha text,
  baseline_complete boolean not null default false,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists github_scan_units (
  fingerprint text primary key,
  repo text not null,
  kind text not null check (kind in ('commit','commit_file','deep_file','text_chunk')),
  lane text not null default 'baseline' check (lane in ('fast','baseline')),
  commit_sha text not null,
  parent_sha text,
  path text,
  blob_sha text,
  payload jsonb not null default '{}'::jsonb,
  scan_mode text not null default 'content'
    check (scan_mode in ('content','path_only')),
  classification_version int not null default 0,
  skip_reason text,
  status text not null default 'pending'
    check (status in ('pending','processing','done','error','audit','skipped')),
  attempt_count int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  github_api_calls int not null default 0,
  chunk_count int not null default 0,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table github_scan_units drop constraint if exists github_scan_units_kind_check;
alter table github_scan_units add constraint github_scan_units_kind_check
  check (kind in ('commit','commit_file','deep_file','text_chunk'));
alter table github_scan_units add column if not exists lane text not null default 'baseline';
alter table github_scan_units add column if not exists scan_mode text not null default 'content';
alter table github_scan_units add column if not exists classification_version int not null default 0;
alter table github_scan_units add column if not exists skip_reason text;
alter table github_scan_units drop constraint if exists github_scan_units_lane_check;
alter table github_scan_units add constraint github_scan_units_lane_check
  check (lane in ('fast','baseline'));
alter table github_scan_units drop constraint if exists github_scan_units_scan_mode_check;
alter table github_scan_units add constraint github_scan_units_scan_mode_check
  check (scan_mode in ('content','path_only'));
alter table github_scan_units drop constraint if exists github_scan_units_status_check;
alter table github_scan_units add constraint github_scan_units_status_check
  check (status in ('pending','processing','done','error','audit','skipped'));

-- Befintlig kö migreras utan att fingerprints ändras.
update github_scan_units
set lane = 'fast'
where kind in ('commit','commit_file') and lane is distinct from 'fast';
update github_scan_units
set lane = 'baseline'
where kind = 'deep_file' and lane is distinct from 'baseline';
update github_scan_units as child
set lane = parent.lane
from github_scan_units as parent
where child.kind = 'text_chunk'
  and child.parent_sha = parent.fingerprint
  and child.lane is distinct from parent.lane;
update github_scan_units
set classification_version = 1
where classification_version < 1
  and (lane = 'fast' or kind <> 'deep_file');
-- Befintliga baseline-filer behåller version 0 för batchmigreringen; alla
-- nyköade rader är redan klassificerade av applikationen.
alter table github_scan_units alter column classification_version set default 1;

-- Gamla binär-audits är inte manuella fel. De går genom den billiga
-- path-only-kön en gång så filnamnet fortfarande lexikonmatchas.
update github_scan_units
set status = 'pending',
    scan_mode = 'path_only',
    skip_reason = coalesce(skip_reason, 'binary-content'),
    attempt_count = 0,
    next_attempt_at = now(),
    locked_at = null,
    processed_at = null,
    last_error = null
where status = 'audit'
  and last_error ilike '%binär fil%';

drop index if exists idx_github_scan_units_ready;
drop index if exists idx_github_scan_units_ready_lane_fifo;
create index if not exists idx_github_scan_units_ready_lane_fifo
  on github_scan_units (lane, scan_mode, created_at)
  include (next_attempt_at)
  where status in ('pending','error')
    and attempt_count < 8
    and classification_version >= 1;
create index if not exists idx_github_scan_units_path_only_ready
  on github_scan_units (created_at)
  where scan_mode = 'path_only'
    and status in ('pending','error')
    and attempt_count < 8;
create index if not exists idx_github_scan_units_unclassified
  on github_scan_units (created_at)
  where lane = 'baseline'
    and kind = 'deep_file'
    and classification_version < 1
    and status in ('pending','error');
create index if not exists idx_github_scan_units_stale
  on github_scan_units (locked_at)
  where status = 'processing';
create index if not exists idx_github_scan_units_exhausted
  on github_scan_units (attempt_count)
  where attempt_count >= 8
    and status in ('pending','error','processing');
create index if not exists idx_github_scan_units_repo
  on github_scan_units (repo, created_at);

-- Råkandidater sparas innan Sonnet så parsefel, timeout och budget aldrig
-- kan radera ett potentiellt fynd.
create table if not exists github_candidates (
  fingerprint text primary key,
  unit_fingerprint text not null references github_scan_units(fingerprint) on delete cascade,
  lane text not null default 'baseline' check (lane in ('fast','baseline')),
  repo text not null,
  path text not null,
  commit_sha text,
  line_number int not null default 1,
  excerpt text not null,
  context text not null,
  term text not null,
  url text not null,
  mode text not null check (mode in ('deep','diff')),
  source text not null check (source in ('rule','haiku')),
  commit_message text,
  status text not null default 'pending'
    check (status in ('pending','processing','judged','error','audit')),
  attempt_count int not null default 0,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  judged_at timestamptz
);

alter table github_candidates drop constraint if exists github_candidates_status_check;
alter table github_candidates add constraint github_candidates_status_check
  check (status in ('pending','processing','judged','error','audit'));
alter table github_candidates add column if not exists lane text not null default 'baseline';
alter table github_candidates drop constraint if exists github_candidates_lane_check;
alter table github_candidates add constraint github_candidates_lane_check
  check (lane in ('fast','baseline'));

update github_candidates as candidate
set lane = unit.lane
from github_scan_units as unit
where candidate.unit_fingerprint = unit.fingerprint
  and candidate.lane is distinct from unit.lane;

drop index if exists idx_github_candidates_ready;
create index if not exists idx_github_candidates_ready_lane_fifo
  on github_candidates (lane, created_at)
  where status in ('pending','error') and attempt_count < 8;
create index if not exists idx_github_candidates_stale
  on github_candidates (locked_at)
  where status = 'processing';
create index if not exists idx_github_candidates_exhausted
  on github_candidates (attempt_count)
  where attempt_count >= 8
    and status in ('pending','error','processing');

create table if not exists github_scan_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null default false,
  repos_touched int not null default 0,
  units_enqueued int not null default 0,
  units_processed int not null default 0,
  path_only_processed int not null default 0,
  github_api_calls int not null default 0,
  claude_haiku_input_tokens bigint not null default 0,
  claude_haiku_output_tokens bigint not null default 0,
  claude_sonnet_input_tokens bigint not null default 0,
  claude_sonnet_output_tokens bigint not null default 0,
  findings_new int not null default 0,
  estimated_cost_usd numeric not null default 0,
  backlog_remaining int not null default 0,
  fast_units_backlog int not null default 0,
  baseline_units_backlog int not null default 0,
  fast_candidates_backlog int not null default 0,
  baseline_candidates_backlog int not null default 0,
  path_only_units_backlog int not null default 0,
  skipped_units_total int not null default 0,
  oldest_fast_age_minutes numeric not null default 0,
  oldest_baseline_age_minutes numeric not null default 0,
  run_duration_seconds int,
  stop_reason text check (stop_reason in ('empty','unit_cap','deadline','budget','error')),
  error text
);

alter table github_scan_runs add column if not exists fast_units_backlog int not null default 0;
alter table github_scan_runs add column if not exists baseline_units_backlog int not null default 0;
alter table github_scan_runs add column if not exists fast_candidates_backlog int not null default 0;
alter table github_scan_runs add column if not exists baseline_candidates_backlog int not null default 0;
alter table github_scan_runs add column if not exists path_only_processed int not null default 0;
alter table github_scan_runs add column if not exists path_only_units_backlog int not null default 0;
alter table github_scan_runs add column if not exists skipped_units_total int not null default 0;
alter table github_scan_runs add column if not exists oldest_fast_age_minutes numeric not null default 0;
alter table github_scan_runs add column if not exists oldest_baseline_age_minutes numeric not null default 0;
alter table github_scan_runs add column if not exists run_duration_seconds int;
alter table github_scan_runs add column if not exists stop_reason text;
alter table github_scan_runs drop constraint if exists github_scan_runs_stop_reason_check;
alter table github_scan_runs add constraint github_scan_runs_stop_reason_check
  check (stop_reason in ('empty','unit_cap','deadline','budget','error'));

create index if not exists idx_github_scan_runs_started
  on github_scan_runs (started_at desc);

-- Klassificerar gammal baseline i begränsade, idempotenta batcher. Funktionen
-- anropas även av scannern så en stor tabell aldrig kräver en massiv UPDATE.
create or replace function classify_github_path_only_units(p_limit int default 5000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  with candidates as materialized (
    select u.fingerprint,
      case
        when u.scan_mode = 'path_only' then coalesce(u.skip_reason, 'path-only')
        when case
          when coalesce(u.payload->>'size', '') ~ '^[0-9]+$' then (u.payload->>'size')::bigint
          else 0
        end > 200000 then 'size>200000'
        when lower(coalesce(u.path, '')) ~ '(^|/)(node_modules|vendor|third_party|dist|build|out|target|coverage|__pycache__|\.venv|venv|\.next|\.nuxt|\.cache|\.turbo|\.pnpm-store|__generated__|generated)(/|$)' then 'denied-directory'
        when lower(coalesce(u.path, '')) ~ '(^|/)(bun\.lock|cargo\.lock|composer\.lock|gemfile\.lock|go\.sum|package-lock\.json|pnpm-lock\.yaml|poetry\.lock|uv\.lock|yarn\.lock)$' then 'lockfile'
        when lower(coalesce(u.path, '')) ~ '\.(7z|a|avi|bin|bmp|bz2|class|db|dll|dylib|eot|exe|gif|gz|ico|jpe?g|lockb|mov|mp3|mp4|o|obj|otf|parquet|pdf|png|pyc|rar|so|sqlite|svg|tar|tflite|ttf|wasm|webm|webp|woff2?|xz|zip|zst)$' then 'binary-extension'
        when lower(coalesce(u.path, '')) ~ '(\.(min|bundle)\.(css|js|mjs|cjs)|\.map|(^|[._-])generated([._-]|$)|\.(designer\.cs|g\.dart|pb\.go))$' then 'generated-output'
        else null
      end as reason
    from github_scan_units u
    where u.lane = 'baseline'
      and u.kind = 'deep_file'
      and u.classification_version < 1
      and u.status in ('pending','error')
    order by u.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  updated as (
    update github_scan_units u
    set scan_mode = case when candidates.reason is null then 'content' else 'path_only' end,
        skip_reason = candidates.reason,
        classification_version = 1,
        next_attempt_at = now()
    from candidates
    where u.fingerprint = candidates.fingerprint
    returning 1
  )
  select count(*)::int into v_updated from updated;
  return v_updated;
end;
$$;

revoke all on function classify_github_path_only_units(int) from public;
grant execute on function classify_github_path_only_units(int) to service_role;

create or replace function claim_github_path_only_units(p_limit int default 5000)
returns setof github_scan_units
language plpgsql
security definer
set search_path = public
as $$
begin
  update github_scan_units
  set status = 'error', locked_at = null, next_attempt_at = now(),
      last_error = coalesce(last_error, 'Stale path-only lock återtagen')
  where scan_mode = 'path_only'
    and status = 'processing'
    and locked_at < now() - interval '30 minutes'
    and attempt_count < 8;

  return query
  with claimed as materialized (
    select u.fingerprint
    from github_scan_units u
    where u.scan_mode = 'path_only'
      and u.status in ('pending','error')
      and u.next_attempt_at <= now()
      and u.attempt_count < 8
    order by case when u.lane = 'fast' then 0 else 1 end, u.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update github_scan_units u
  set status = 'processing',
      locked_at = now(),
      attempt_count = u.attempt_count + 1
  from claimed
  where u.fingerprint = claimed.fingerprint
  returning u.*;
end;
$$;

revoke all on function claim_github_path_only_units(int) from public;
grant execute on function claim_github_path_only_units(int) to service_role;

-- Atomisk claim. En avbruten worker återtas efter 30 minuter.
drop function if exists claim_github_scan_units(int);
create or replace function claim_github_scan_units(
  p_limit int default 20,
  p_preferred_lane text default 'fast'
)
returns setof github_scan_units
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Stale processing återställs separat så ready-claimen kan använda sitt
  -- smala partial-index utan ett dyrt OR över hela kön.
  update github_scan_units
  set status = 'error',
      locked_at = null,
      next_attempt_at = now(),
      last_error = coalesce(last_error, 'Stale lock återtagen')
  where status = 'processing'
    and locked_at < now() - interval '30 minutes'
    and attempt_count < 8;

  update github_scan_units
  set status = 'audit',
      locked_at = null,
      processed_at = now(),
      last_error = coalesce(last_error, 'Retrygräns nådd')
  where attempt_count >= 8
    and (
      status in ('pending','error')
      or (status = 'processing' and locked_at < now() - interval '30 minutes')
    );

  return query
  with preferred as materialized (
    select u.fingerprint
    from github_scan_units u
    where u.status in ('pending','error')
      and u.next_attempt_at <= now()
      and u.attempt_count < 8
      and u.scan_mode = 'content'
      and u.classification_version >= 1
      and u.lane = case when p_preferred_lane = 'baseline' then 'baseline' else 'fast' end
    order by u.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  fallback as materialized (
    select u.fingerprint
    from github_scan_units u
    where u.status in ('pending','error')
      and u.next_attempt_at <= now()
      and u.attempt_count < 8
      and u.scan_mode = 'content'
      and u.classification_version >= 1
      and u.lane <> case when p_preferred_lane = 'baseline' then 'baseline' else 'fast' end
    order by u.created_at
    limit greatest(p_limit - (select count(*)::int from preferred), 0)
    for update skip locked
  ),
  claimed as materialized (
    select fingerprint from preferred
    union all
    select fingerprint from fallback
  )
  update github_scan_units u
  set status = 'processing',
      locked_at = now(),
      attempt_count = u.attempt_count + 1
  from claimed
  where u.fingerprint = claimed.fingerprint
  returning u.*;
end;
$$;

revoke all on function claim_github_scan_units(int, text) from public;
grant execute on function claim_github_scan_units(int, text) to service_role;

drop function if exists claim_github_candidates(int);
create or replace function claim_github_candidates(
  p_limit int default 60,
  p_preferred_lane text default 'fast'
)
returns setof github_candidates
language plpgsql
security definer
set search_path = public
as $$
begin
  update github_candidates
  set status = 'error',
      locked_at = null,
      last_error = coalesce(last_error, 'Stale lock återtagen')
  where status = 'processing'
    and locked_at < now() - interval '30 minutes'
    and attempt_count < 8;

  update github_candidates
  set status = 'audit',
      locked_at = null,
      last_error = coalesce(last_error, 'Retrygräns nådd')
  where attempt_count >= 8
    and (
      status in ('pending','error')
      or (status = 'processing' and locked_at < now() - interval '30 minutes')
    );

  return query
  with preferred as materialized (
    select c.fingerprint
    from github_candidates c
    where c.status in ('pending','error')
      and c.attempt_count < 8
      and c.lane = case when p_preferred_lane = 'baseline' then 'baseline' else 'fast' end
    order by c.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  ),
  fallback as materialized (
    select c.fingerprint
    from github_candidates c
    where c.status in ('pending','error')
      and c.attempt_count < 8
      and c.lane <> case when p_preferred_lane = 'baseline' then 'baseline' else 'fast' end
    order by c.created_at
    limit greatest(p_limit - (select count(*)::int from preferred), 0)
    for update skip locked
  ),
  claimed as materialized (
    select fingerprint from preferred
    union all
    select fingerprint from fallback
  )
  update github_candidates c
  set status = 'processing',
      locked_at = now(),
      attempt_count = c.attempt_count + 1
  from claimed
  where c.fingerprint = claimed.fingerprint
  returning c.*;
end;
$$;

revoke all on function claim_github_candidates(int, text) from public;
grant execute on function claim_github_candidates(int, text) to service_role;

drop function if exists get_github_backlog_metrics();
create or replace function get_github_backlog_metrics()
returns table (
  fast_units bigint,
  baseline_units bigint,
  fast_candidates bigint,
  baseline_candidates bigint,
  path_only_units bigint,
  skipped_units bigint,
  oldest_fast_minutes numeric,
  oldest_baseline_minutes numeric
)
language sql
security definer
set search_path = public
as $$
  with active_units as (
    select lane, created_at
    from github_scan_units
    where status in ('pending','error','processing')
      and scan_mode = 'content'
  ),
  active_candidates as (
    select lane, created_at
    from github_candidates
    where status in ('pending','error','processing')
  ),
  combined as (
    select lane, created_at from active_units
    union all
    select lane, created_at from active_candidates
  ),
  path_only as (
    select count(*) as amount
    from github_scan_units
    where scan_mode = 'path_only'
      and status in ('pending','error','processing')
  ),
  skipped as (
    select count(*) as amount
    from github_scan_units
    where status = 'skipped'
  )
  select
    (select count(*) from active_units where lane = 'fast'),
    (select count(*) from active_units where lane = 'baseline'),
    (select count(*) from active_candidates where lane = 'fast'),
    (select count(*) from active_candidates where lane = 'baseline'),
    (select amount from path_only),
    (select amount from skipped),
    coalesce((select extract(epoch from (now() - min(created_at))) / 60 from combined where lane = 'fast'), 0),
    coalesce((select extract(epoch from (now() - min(created_at))) / 60 from combined where lane = 'baseline'), 0);
$$;

revoke all on function get_github_backlog_metrics() from public;
grant execute on function get_github_backlog_metrics() to service_role;

-- Pump.fun coins vars website pekar på GitHub (live-scannern).
create table if not exists github_coins (
  mint text primary key,
  name text not null default '',
  symbol text not null default '',
  website text not null,
  github_url text not null,
  github_owner text not null,
  github_repo text,
  repo_stars int,
  repo_created_at timestamptz,
  repo_age_days int,
  repo_language text,
  market_cap numeric,
  found_at timestamptz not null default now(),
  source text not null check (source in ('live','backfill')),
  queued_for_morning boolean default false,
  repo_missing boolean default false,
  twitter_url text,
  tweet_text text
);

alter table github_coins add column if not exists twitter_url text;
alter table github_coins add column if not exists tweet_text text;

create index if not exists idx_github_coins_found on github_coins (found_at desc);
create index if not exists idx_github_coins_queued on github_coins (queued_for_morning) where queued_for_morning = true;

-- ===== News Watch Scanner =====

-- Google News-sökningar som styrs via #news-watchlist.
create table if not exists news_topics (
  id bigint generated always as identity primary key,
  query text not null unique,
  active boolean not null default true,
  added_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Artiklar sparas före Claude-anropet så samma artikel aldrig analyseras/pingas igen.
create table if not exists news_articles (
  fingerprint text primary key,
  title text not null,
  source_name text,
  url text not null,
  published_at timestamptz,
  summary text,
  article_excerpt text,
  matched_topics jsonb not null default '[]'::jsonb,
  status text not null default 'pending'
    check (status in ('pending','analyzed','skipped','alerted','error')),
  score int,
  candidate jsonb,
  ready_post text,
  analyzed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table news_articles add column if not exists ready_post text;

-- Kevin-exempel: artikel → coinnamn/ticker → exakt X-post. Few-shot-minne för Sonnet.
create table if not exists news_examples (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  article_url text not null,
  article_title text,
  article_summary text,
  coin_name text not null,
  ticker text not null,
  x_post text not null,
  source_message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_news_topics_active on news_topics (active);
create index if not exists idx_news_articles_created on news_articles (created_at desc);
create index if not exists idx_news_articles_status on news_articles (status);
create index if not exists idx_news_examples_active on news_examples (active, created_at desc);

-- ===== Twitter Scanner V1 =====

create table if not exists twitter_queries (
  id bigint generated always as identity primary key,
  query text not null unique,
  active boolean not null default true,
  added_by text,
  last_scanned_at timestamptz,
  search_count bigint not null default 0,
  result_count bigint not null default 0,
  alert_count bigint not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists twitter_origins (
  tweet_id text primary key,
  url text not null,
  text text not null,
  author_handle text not null,
  tweet_created_at timestamptz not null,
  source_thread jsonb not null default '[]'::jsonb,
  matched_query_ids jsonb not null default '[]'::jsonb,
  view_count bigint not null default 0,
  like_count bigint not null default 0,
  retweet_count bigint not null default 0,
  reply_count bigint not null default 0,
  approximate_velocity numeric not null default 0,
  observed_velocity numeric,
  status text not null default 'watching'
    check (status in ('watching','pending','judging','approved','writing','alerted','skipped','error','audit')),
  attempt_count int not null default 0,
  judge_attempt_count int not null default 0,
  writer_attempt_count int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  decision jsonb,
  ready_post text,
  alerted_at timestamptz,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table twitter_origins add column if not exists judge_attempt_count int not null default 0;
alter table twitter_origins add column if not exists writer_attempt_count int not null default 0;

-- Sökresultat sparas före origin-lookups så deadline/API-fel aldrig tappar Top-träffar.
create table if not exists twitter_discoveries (
  tweet_id text primary key,
  query_id bigint references twitter_queries(id) on delete set null,
  tweet jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','processing','done','error','audit')),
  attempt_count int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists twitter_observations (
  id bigint generated always as identity primary key,
  tweet_id text not null references twitter_origins(tweet_id) on delete cascade,
  observed_at timestamptz not null default now(),
  view_count bigint not null default 0,
  like_count bigint not null default 0,
  retweet_count bigint not null default 0,
  reply_count bigint not null default 0,
  views_per_hour numeric
);

create table if not exists twitter_examples (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  origin_url text not null,
  origin_text text,
  coin_name text not null,
  ticker text not null,
  x_post text not null,
  source_message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists twitter_scan_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  queries_claimed int not null default 0,
  search_calls int not null default 0,
  lookup_calls int not null default 0,
  empty_twitter_calls int not null default 0,
  returned_tweets int not null default 0,
  origins_saved int not null default 0,
  origins_watching int not null default 0,
  origins_immediate int not null default 0,
  origins_confirmed int not null default 0,
  origins_expired int not null default 0,
  origins_judged int not null default 0,
  posts_written int not null default 0,
  alerts_sent int not null default 0,
  anthropic_input_tokens bigint not null default 0,
  anthropic_output_tokens bigint not null default 0,
  twitter_cost_usd numeric not null default 0,
  claude_cost_usd numeric not null default 0,
  backlog int not null default 0,
  oldest_pending_minutes numeric not null default 0,
  run_duration_seconds int,
  stop_reason text check (stop_reason in ('empty','complete','deadline','twitter_budget','claude_budget','locked','error')),
  error text
);
alter table twitter_scan_runs add column if not exists empty_twitter_calls int not null default 0;
alter table twitter_scan_runs add column if not exists origins_watching int not null default 0;
alter table twitter_scan_runs add column if not exists origins_immediate int not null default 0;
alter table twitter_scan_runs add column if not exists origins_confirmed int not null default 0;
alter table twitter_scan_runs add column if not exists origins_expired int not null default 0;

create table if not exists twitter_runtime_lock (
  singleton boolean primary key default true check (singleton),
  owner text,
  locked_until timestamptz
);
insert into twitter_runtime_lock (singleton) values (true) on conflict (singleton) do nothing;

create index if not exists idx_twitter_queries_rotation
  on twitter_queries (active, last_scanned_at nulls first, created_at);
create index if not exists idx_twitter_origins_claim
  on twitter_origins (status, next_attempt_at, inserted_at);
create index if not exists idx_twitter_discoveries_claim
  on twitter_discoveries (status, next_attempt_at, created_at);
create index if not exists idx_twitter_origins_watch
  on twitter_origins (status, updated_at) where status = 'watching';
create index if not exists idx_twitter_observations_tweet
  on twitter_observations (tweet_id, observed_at desc);
create index if not exists idx_twitter_examples_active
  on twitter_examples (active, created_at desc);
create index if not exists idx_twitter_scan_runs_started
  on twitter_scan_runs (started_at desc);

create or replace function claim_twitter_queries(p_limit int default 6)
returns setof twitter_queries
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as materialized (
    select q.id
    from twitter_queries q
    where q.active = true
    order by q.last_scanned_at nulls first, q.created_at, q.id
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update twitter_queries q
  set last_scanned_at = now(),
      search_count = q.search_count + 1,
      updated_at = now()
  from claimed
  where q.id = claimed.id
  returning q.*;
end;
$$;

create or replace function claim_twitter_judge(p_limit int default 6)
returns setof twitter_origins
language plpgsql
security definer
set search_path = public
as $$
begin
  update twitter_origins
  set status = 'pending', locked_at = null
  where status = 'judging' and locked_at < now() - interval '30 minutes';

  update twitter_origins
  set status = 'audit', locked_at = null,
      last_error = coalesce(last_error, 'Retrygräns nådd')
  where judge_attempt_count >= 8
    and decision is null
    and status in ('pending','error');

  return query
  with claimed as materialized (
    select o.tweet_id
    from twitter_origins o
    where o.decision is null
      and o.status in ('pending','error')
      and o.next_attempt_at <= now()
      and o.judge_attempt_count < 8
    order by coalesce(o.observed_velocity, o.approximate_velocity) desc, o.inserted_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update twitter_origins o
  set status = 'judging',
      locked_at = now(),
      attempt_count = o.attempt_count + 1,
      judge_attempt_count = o.judge_attempt_count + 1
  from claimed
  where o.tweet_id = claimed.tweet_id
  returning o.*;
end;
$$;

create or replace function claim_twitter_discoveries(p_limit int default 30)
returns setof twitter_discoveries
language plpgsql
security definer
set search_path = public
as $$
begin
  update twitter_discoveries
  set status = 'pending', locked_at = null
  where status = 'processing' and locked_at < now() - interval '30 minutes';

  update twitter_discoveries
  set status = 'audit', locked_at = null,
      last_error = coalesce(last_error, 'Retrygräns nådd')
  where attempt_count >= 8 and status in ('pending','error');

  return query
  with claimed as materialized (
    select d.tweet_id
    from twitter_discoveries d
    where d.status in ('pending','error')
      and d.next_attempt_at <= now()
      and d.attempt_count < 8
    order by d.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update twitter_discoveries d
  set status = 'processing',
      locked_at = now(),
      attempt_count = d.attempt_count + 1
  from claimed
  where d.tweet_id = claimed.tweet_id
  returning d.*;
end;
$$;

create or replace function claim_twitter_writer(p_limit int default 6)
returns setof twitter_origins
language plpgsql
security definer
set search_path = public
as $$
begin
  update twitter_origins
  set status = 'approved', locked_at = null
  where status = 'writing' and locked_at < now() - interval '30 minutes';

  update twitter_origins
  set status = 'audit', locked_at = null,
      last_error = coalesce(last_error, 'Retrygräns nådd')
  where writer_attempt_count >= 8
    and decision is not null
    and ready_post is null
    and status in ('approved','error');

  return query
  with claimed as materialized (
    select o.tweet_id
    from twitter_origins o
    where o.decision is not null
      and (o.decision->>'approved')::boolean = true
      and o.ready_post is null
      and o.status in ('approved','error')
      and o.next_attempt_at <= now()
      and o.writer_attempt_count < 8
    order by coalesce(o.observed_velocity, o.approximate_velocity) desc, o.inserted_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update twitter_origins o
  set status = 'writing',
      locked_at = now(),
      attempt_count = o.attempt_count + 1,
      writer_attempt_count = o.writer_attempt_count + 1
  from claimed
  where o.tweet_id = claimed.tweet_id
  returning o.*;
end;
$$;

create or replace function get_twitter_backlog_metrics()
returns table (backlog bigint, oldest_pending_minutes numeric)
language sql
security definer
set search_path = public
as $$
  with pending as (
    select inserted_at as queued_at
    from twitter_origins
    where status in ('pending','judging','approved','writing','error')
    union all
    select created_at
    from twitter_discoveries
    where status in ('pending','processing','error')
  )
  select
    count(*),
    coalesce(extract(epoch from (now() - min(queued_at))) / 60, 0)
  from pending;
$$;

create or replace function prune_twitter_observations(p_keep_days int default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare deleted_count bigint;
begin
  delete from twitter_observations
  where observed_at < now() - make_interval(days => greatest(p_keep_days, 1));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function claim_twitter_run(p_owner text, p_ttl_minutes int default 12)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare claimed boolean;
begin
  update twitter_runtime_lock
  set owner = p_owner,
      locked_until = now() + make_interval(mins => greatest(p_ttl_minutes, 1))
  where singleton = true
    and (locked_until is null or locked_until < now() or owner = p_owner)
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function release_twitter_run(p_owner text)
returns void
language sql
security definer
set search_path = public
as $$
  update twitter_runtime_lock
  set owner = null, locked_until = null
  where singleton = true and owner = p_owner;
$$;

revoke all on function claim_twitter_queries(int) from public;
revoke all on function claim_twitter_discoveries(int) from public;
revoke all on function claim_twitter_judge(int) from public;
revoke all on function claim_twitter_writer(int) from public;
revoke all on function get_twitter_backlog_metrics() from public;
revoke all on function prune_twitter_observations(int) from public;
revoke all on function claim_twitter_run(text, int) from public;
revoke all on function release_twitter_run(text) from public;
grant execute on function claim_twitter_queries(int) to service_role;
grant execute on function claim_twitter_discoveries(int) to service_role;
grant execute on function claim_twitter_judge(int) to service_role;
grant execute on function claim_twitter_writer(int) to service_role;
grant execute on function get_twitter_backlog_metrics() to service_role;
grant execute on function prune_twitter_observations(int) to service_role;
grant execute on function claim_twitter_run(text, int) to service_role;
grant execute on function release_twitter_run(text) to service_role;
