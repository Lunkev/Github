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
