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
