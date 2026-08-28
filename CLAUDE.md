# narrative-scanner — kontext för AI-assistenten (Cursor)

**NUVARANDE FOKUS: GitHub-scannern. Läs PLAN-GITHUB.md först** — det är den aktiva specen.
PLAN.md beskriver det större systemet (bred narrativ-scanning) som är PAUSAT tills GitHub-delen sitter.
STARTA-HAR.md är ägarens manuella setup-checklista.

## Vad projektet är
Proaktiv narrativ-scanner för en Solana-memecoin-deployer. Samlar signaler (nyhets-RSS, Hacker News, Google Trends, Reddit, X via twitterapi.io, TikTok via Apify, DexScreener), låter Claude API scora memecoin-kandidater, skickar daglig brief till Discord, sparar allt i Supabase. Separat system från ägarens "coin-agent" (som bevakar pump.fun nedströms).

## Arkitekturprinciper
- **En trasig källa får ALDRIG fälla en skanning** — alla fetchers returnerar `[]` vid fel, aldrig throw.
- Alla källor normaliseras till `Signal` (src/types.ts) — allt nedströms är källoberoende.
- Nya källor = ny fil i `src/sources/` som exporterar `fetchX(): Promise<Signal[]>`, plus en rad i `src/index.ts`.
- Ingen server: körs som cron via GitHub Actions (`.github/workflows/daily.yml`). Secrets ligger i repo-settings.
- Kostnadsdisciplin: gratis-källor först, betalanrop (twitterapi.io, Apify, Claude) hålls till 2–3 körningar/dag.
- `npm run scan -- --dry` = torrkörning utan nycklar/DB/Discord. Ska alltid fungera.

## GitHub-scannern (aktivt arbete)
Flöde: `src/githubScan.ts` → Discord-inläsning (`src/discord/ingest.ts`: #watchlist + #proven) → watchlist expanderas → djupscan/diff-vakt (`src/github/scan.ts`) → lexikonfilter (`src/github/lexicon.ts`) → Claude-bedömning + DexScreener-koll (`src/github/judge.ts`) → alerts (`src/github/alert.ts`, hot/maybe, dagtid 07–23 Europe/Stockholm, nattfynd köas till morgonbrief). State + fynd i Supabase (`src/db/githubStore.ts`).

Öppna TODOs för GitHub-scannern, i prioritetsordning:
1. Testa hela kedjan skarpt med riktiga nycklar (ägaren gör setup enligt STARTA-HAR.md) och justera judge-promptens hårdhet efter första veckans brus.
2. "Nytt repo i bevakad org"-förslag till Discord (nu expanderas orgs tyst; posta en fråga i #watchlist istället när ett nytt repo dyker upp).
3. 💎-reaktion på #gems-maybe-fynd → promota till proven + lexikon (läs reaktioner via REST i ingest-steget).
4. Git-historik-läge: skanna även raderade filer/gamla commits (git log-diffar bakåt i tiden) — fynd ingen annan ser.
5. Issues/PRs/commit-kommentarer som källa (utvecklarnas skämt och kodnamn).
6. Uppföljning: när ägaren launchat ett fynd, markera `findings.launched` och följ utfallet via DexScreener → auto-förslag till proven_coins.

## Pausat (väcks efter GitHub-delen)
- Bred narrativ-scanning (`src/index.ts`): twitterapi.io-endpoints behöver verifieras, TikTok via Apify, feedback-loop, intradag-alerts.

## Stil
- TypeScript strict, ESM, inga onödiga dependencies.
- Svenska i kommentarer och Discord-output är OK (ägaren är svensk).
