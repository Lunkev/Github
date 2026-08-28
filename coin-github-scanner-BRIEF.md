# Handoff brief: pump.fun → GitHub-link scanner

Context for an AI coding agent. Written in English for reliability; the human is Swedish-speaking.

---

## 1. What this is

A new module to be added to an **existing GitHub-scanner project** (Node, built in Cursor, Discord alerts).

The existing scanner runs **repo → find easter egg → launch a coin**.
This module runs the **opposite direction: coin → does it link to a GitHub repo?**

Goal: detect pump.fun launches whose metadata `website` field points at github.com. These are people already playing the "GitHub narrative" meta. Used both as a live alert (act within minutes) and as a research/backfill tool (map the meta).

**Hard requirement from the user: match GitHub links in the `website` field only.** Not description, not twitter. He was explicit. Keep description-matching behind an off-by-default flag at most.

---

## 2. Verified facts (measured 2026-08-28, do not re-derive)

### Where the GitHub link actually lives

pump.fun's `/coins` API returns `twitter` and `telegram` but **no `website` key**. Website lives in the off-chain JSON behind `metadata_uri`, in one of two shapes:

```json
{ "name": "...", "symbol": "...", "description": "...", "image": "...",
  "website": "https://..." }
```

```json
{ "name": "...", "symbol": "...", "description": "...", "image": "...",
  "extensions": { "website": "https://..." } }
```

**Both shapes occur in production.** Reading only top-level `website` loses a large fraction of coins. Check `meta.website || meta.extensions?.website`.

### API endpoints and their limits

| Endpoint | Status |
|---|---|
| `GET https://frontend-api-v3.pump.fun/coins?offset=&limit=&sort=&order=&includeNsfw=true` | works, returns `mint`, `name`, `symbol`, `description`, `metadata_uri`, `usd_market_cap`, `created_timestamp` |
| `GET https://frontend-api-v3.pump.fun/coins/{mint}` | works, full coin object, still no `website` |
| `GET https://frontend-api-v3.pump.fun/coins/search?...` | **404 — dead on v3.** Do not build on it. |

**Critical: offset caps at ~1000.** Measured: offset 1000 returns data; offset 1200, 1500, 2500, 5000, 30000 all return `[]`. There is no cursor pagination. So the list API can reach back roughly 37 hours and no further, and cannot be used for a real historical backfill.

### Launch volume

The two newest coins were 3 seconds apart → roughly 29,000 launches/day → ~58,000 per 48h. Design for that scale.

### Metadata hosts are NOT all IPFS

Observed in one sweep: `ipfs.io`, `gateway.irys.xyz`, `meta.uxento.io`, `metadata.j7tracker.io`, `md.violasnipe.com`, `md.sdfgsdfsdf.uk`, `m.rapidlaunch.io`, `ipfs.launchblitz.ai`, `storage.googleapis.com`, `pub-*.r2.dev`, `pf.jake-*.workers.dev`.

Each launchpad tool ships its own metadata host. If the fetcher only understands `/ipfs/`, it silently drops a large share of launches. Handle: if URI matches `/ipfs/([A-Za-z0-9]+)/`, extract CID and use a gateway; otherwise fetch the URI directly.

### IPFS gateways

`ipfs.io` and `dweb.link` returned **403** under load. Working: **`gateway.pinata.cloud`** (verified) and `pump.mypinata.cloud`. Rotate across a list with fallback; a single gateway will rate-limit during a sweep.

### Spam hosts worth blocklisting

`meta.uxento.io`, `metadata.j7tracker.io`, `m.rapidlaunch.io`, `ipfs.launchblitz.ai` are bulk-launcher farms — one sweep showed the identical coin ("HELLO ITS RE") minted 6 times in a row. They never carry GitHub links. Host-level blocklist cuts a lot of fetch volume at near-zero risk. Make it a config array, not hardcoded.

---

## 3. Architecture

Two modes sharing one check function.

### Mode A — `live` (primary; this is what generates entries)

1. Connect `wss://pumpportal.fun/api/data`, send `{"method":"subscribeNewToken"}`.
2. Each event carries `mint`, `name`, `symbol`, **`uri`** — the metadata URI arrives inline, so no extra lookup is needed to find it.
3. Fetch the URI (gateway rotation / direct).
4. Extract `website`, regex `/https?:\/\/(?:www\.)?github\.com\/([\w.-]+)(?:\/([\w.-]+))?/i`.
5. On hit: enrich, persist, alert Discord.

Free. ~1 fetch every 3 seconds average. Reconnect on close.

### Mode B — `backfill` (research; run on demand)

The pump.fun list API only reaches ~1000 coins, so real history must come from **Helius** (the user already has an account; free tier is sufficient).

Two viable routes — the implementing agent should verify which is cheaper in credits before committing:

- `getSignaturesForAddress` on the pump.fun program, walk back to the desired timestamp, parse the `create` instruction for mint + URI.
- DAS `searchAssets` filtered on pump.fun's update authority `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`, 1000 assets per page, read `content.json_uri`.

**DAS caveat:** `content.links.external_url` is a fast path to the website, but DAS normalizes the off-chain JSON and does **not** reliably map `extensions.website`. Use it as a fast filter, then fall back to fetching raw JSON for any asset where `external_url` is absent. Do not rely on DAS alone — it will silently miss the `extensions` shape.

A 24h backfill is ~29k coins. At 100 concurrent small fetches this is minutes, not hours. The limit is rate limits, not bandwidth (~300 bytes per JSON).

---

## 4. Enrichment (on hit, before alerting)

Call `GET https://api.github.com/repos/{owner}/{repo}` (add `GITHUB_TOKEN` → 5000 req/h instead of 60).

Capture `stargazers_count`, `created_at`, `pushed_at`, `language`, `description`, and derive `age_days`.

Why it matters: a repo created days ago with almost no stars is a fresh narrative play. A repo with thousands of stars is an established project someone is riding. Different trades — surface the distinction in the alert. Also flag when the repo 404s (dead or private link).

---

## 5. Integration points with the existing project

The new module should reuse, not duplicate:

- the existing **Discord webhook / send helper** — same channel as the GitHub scanner
- the existing **dedupe / seen-store** (Supabase if already wired, otherwise a local JSON set keyed by mint)
- the existing **quiet-hours logic**: the user wants daytime alerts only; night finds go into a morning-brief backlog. He launches within minutes, so a 3am ping is worthless.
- existing config/env loading

New files should live beside the existing scanners rather than modifying them. The only shared touchpoints are the entry/router file and the Discord sender — do those last, in one small commit, so they are easy to review.

Suggested table `github_coins`: `mint` (pk), `name`, `symbol`, `website`, `github_url`, `github_owner`, `github_repo`, `repo_stars`, `repo_created_at`, `repo_age_days`, `market_cap`, `found_at`, `source` (`live` | `backfill`).

---

## 6. Alert format

Keep it scannable — he acts in minutes:

```
$SYMBOL — Name
github.com/owner/repo  ·  142★  ·  repo 4d old  ·  TypeScript
website: https://github.com/owner/repo
https://pump.fun/<mint>
```

---

## 7. Env

```
DISCORD_WEBHOOK_URL=
HELIUS_API_KEY=
GITHUB_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
QUIET_HOURS=23-8
```

---

## 8. Deployment note

**Vercel will not work for `live` mode.** Serverless kills long-lived websockets. Needs a always-on host: Railway, Fly.io, a small VPS, or the user's own machine. `backfill` is a one-shot script and can run anywhere.

---

## 9. Out of scope

- No auto-buying, no trade execution. Detection and alerting only.
- No auto-populated "proven coins" library — the user curates that manually by design.
- Do not build on `/coins/search` (dead) or on deep offset pagination (capped).

---

## 10. Known-good test fixture

Mint `4UYz5jMQr2fZSfiqsdZ4zXLuB6o8SpMGN8sG82jBpump` (CyberLeek) uses the `extensions.website` shape:

```
https://gateway.pinata.cloud/ipfs/bafkreibepim3k3ykk6lh4ny6a3zvq4aajlawnhcnk6jqjqb7oy3vke4xfi
→ { ..., "extensions": { "website": "https://leek.ar.io" } }
```

Use it as a unit test for the `extensions` path — that is the shape a naive implementation drops. Its website is not a GitHub link, so it should parse successfully and produce **no** hit.
