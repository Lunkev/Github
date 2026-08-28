# GitHub-scannern — plan (v1-fokus)

> En sak i taget. Detta är det vi bygger FÖRST och gör riktigt bra: easter egg-jakt i utvalda GitHub-repos, à la $MYC ("my coin" i pump.funs officiella repo).

## Så funkar loopen

**Setup (en gång per repo)**
1. Kevin lägger repos på watchlisten via Discord (`#watchlist`: "add pump-fun").
2. Scannern djupläser hela repot en gång (markdown, docs, exempel, config, filnamn) och flaggar allt launchbart som redan ligger där.

**Varje timme (cron)**
3. Hämta allt NYTT sen sist i bevakade repos: commits, nya filer, branches, nya repos i orgen.
4. **Steg 1 — lexikonfilter (gratis)**: textmatcha lexikonet ("coin", "dog", "cat", "trading bot", ticker-mönster, "example token"...) över innehållet.
5. **Steg 2 — Claude-bedömning**: bara träffarna skickas till Claude: riktigt fynd eller brus? Verdict: `hot` / `maybe` / `skip`.
6. **Olaunchad-koll**: DexScreener-sök på namnet. Redan launchad med volym → tyst. Olaunchad → vidare.

**Leverans**
7. Dagtid (07–23 svensk tid): `hot` → alert direkt i Discord med färdigt launch-kit: citat, permalänk till fil/rad/commit, ticker-förslag, tweet-utkast i MYC-stil, "OLAUNCHAD ✅". `maybe` → tystare kanal/tråd.
8. Natt: fynden sparas och morgonbriefen kl 07 öppnar med "X fynd från i natt, ingen har launchat dem än".

**Träningen (det som gör systemet unikt)**
9. Kevin klistrar in bevisade launches (gärna med GitHub-länk) i `#proven` → Claude generaliserar mönstret → nya söktermer läggs i lexikonet automatiskt. Systemet ärver Kevins blick, ett fynd i taget.
10. Ny repo i bevakad org → systemet föreslår "lägga till?" i Discord.

## Beslut från brainstormen

- Fokus: **namngivna eggs** (MYC-klassen). Git-historik, issues/PRs och feature-hintar är senare utbyggnader.
- Brus hanteras med två nivåer (hot/maybe) + tvåstegsfiltret.
- Alerts bara dagtid; natt → morgonbrief.
- Watchlist: manuell + förslag från systemet.
- Lexikonet växer via #proven-inskick — Kevin skriver aldrig regler för hand.
- Discord är kontrollytan i v1. Dashboard är ett senare fönster mot samma databas — inget ombygge krävs.

## Kostnad

Allt är gratis (GitHub API, Discord, DexScreener, Supabase free tier, GitHub Actions) utom Claude API: uppskattat **$3–10/mån** vid timkörningar på 5–10 repos, eftersom steg 1-filtret slänger ~95 % av bruset innan Claude ser något.

## Arkitektur i mappen

```
src/githubScan.ts        <- entrypoint: körs varje timme av cron
src/github/api.ts        <- GitHub REST-anrop (token, rate limits)
src/github/lexicon.ts    <- seed-termer + inlärda termer från DB
src/github/scan.ts       <- djupscan + diff-vakt -> råträffar
src/github/judge.ts      <- Claude bedömer träffar -> findings + launch-kit
src/github/alert.ts      <- Discord-alerts (hot/maybe, dagtidslogik)
src/discord/ingest.ts    <- läser #proven + #watchlist via bot-token
supabase/schema.sql      <- alla tabeller (körs en gång i Supabase)
.github/workflows/github-scan.yml <- timvis cron
```

Den breda narrativ-scannern (nyheter/trender/Reddit, `src/index.ts`) ligger kvar i samma mapp men är pausad — vi väcker den när GitHub-delen sitter.
