# STARTA HÄR — din manuella checklista

Allt nedan gör du EN gång. Totalt ~30–45 min. Sen sköter systemet sig självt.

## 1. Öppna projektet i Cursor (2 min)
- [ ] Packa upp mappen, öppna den i Cursor
- [ ] Terminal: `npm install`
- [ ] Kopiera `.env.example` → `.env` (nycklarna nedan klistras in här efter hand)

## 2. Discord (10 min)
- [ ] Skapa kanaler i din server: `#gems-hot`, `#gems-maybe`, `#proven`, `#watchlist`
- [ ] Webhook för alerts: Serverinställningar → Integrationer → Webhooks → Ny webhook → välj `#gems-hot` → kopiera URL → `DISCORD_WEBHOOK_URL` i .env
- [ ] Samma sak för `#gems-maybe` → `DISCORD_WEBHOOK_MAYBE`
- [ ] Bot (för att LÄSA #proven/#watchlist): gå till https://discord.com/developers/applications → New Application → fliken Bot → Reset Token → kopiera → `DISCORD_BOT_TOKEN`
  - Under Bot: slå på "Message Content Intent"
  - Fliken OAuth2 → URL Generator: bocka `bot` + permissions "View Channels" och "Read Message History" → öppna länken → bjud in boten till din server
- [ ] Kanal-ID:n: slå på Developer Mode i Discord (Inställningar → Avancerat) → högerklicka `#proven` → Copy Channel ID → `CHANNEL_PROVEN_ID`. Samma för `#watchlist` → `CHANNEL_WATCHLIST_ID`

## 3. GitHub-token (3 min)
- [ ] github.com → Settings → Developer settings → Personal access tokens → Fine-grained → Generate. Public repos, read-only räcker. → `GITHUB_TOKEN`

## 4. Anthropic-nyckel (5 min)
- [ ] console.anthropic.com → API Keys → skapa nyckel → `ANTHROPIC_API_KEY`
- [ ] Ladda kontot med $10 och kolla förbrukningen där efter en vecka

## 5. Supabase (10 min)
- [ ] supabase.com → New project (gratis)
- [ ] SQL Editor → klistra in hela `supabase/schema.sql` → Run
- [ ] Project Settings → API: kopiera Project URL → `SUPABASE_URL`
- [ ] **service_role**-nyckeln (Reveal, *inte* `anon` / `publishable`) → `SUPABASE_SERVICE_KEY`
  - anon-nyckeln blockeras av RLS — tabellerna blir tomma även om scannen "lyckas"

## 6. Testa lokalt (5 min)
- [ ] `npm run github -- --dry` — ska lista vad den SKULLE skanna (funkar utan alla nycklar)
- [ ] `npm run github` — skarp körning: djupscannar watchlisten, postar ev. fynd i Discord
- [ ] Skriv `add pump-fun` i `#watchlist`, kör igen — repot ska dyka upp i databasen

## 7. Sätt igång cronen (10 min)
- [ ] Skapa ett GitHub-repo (publikt = gratis obegränsad Actions; koden avslöjar inget känsligt) och pusha mappen
- [ ] Repo → Settings → Secrets and variables → Actions → lägg in ALLA nycklar från .env med samma namn
- [ ] Fliken Actions → workflow "github-scan" → Run workflow (testa manuellt en gång)
- [ ] Klart — den kör nu varje timme själv

## Vardagen efter setup
- Launch som funkat? → klistra in i `#proven` (namn, ticker, tweet, GitHub-länk om det var ett repo-fynd)
- Nytt repo att bevaka? → skriv `add <org eller org/repo>` i `#watchlist`
- Alerts kommer i `#gems-hot` (pling) och `#gems-maybe` (skrolla när du har tid)

## 8. Pump.fun GitHub-länkar (motsatt scanner)
- [ ] Skapa kanal `#github-coins` (inte gems) → webhook → `DISCORD_WEBHOOK_PUMP_GITHUB` i `.env`
- [ ] SQL: kör `github_coins`-tabellen i `supabase/schema.sql` om du inte körde hela filen på nytt
- [ ] `npm run pump-github -- --selftest` sedan `npm run pump-github` (lokalt test; måste vara igång för att fånga launches)
- [ ] För dygnet runt: **Railway** (~$5/mån Hobby) — **inte** GitHub Actions eller Vercel
  1. [railway.app](https://railway.app) → Hobby-plan → logga in med GitHub
  2. New Project → Deploy from GitHub repo → `Lunkev/Github` → branch `main`
  3. En service, ingen databas. Generera ingen public domain
  4. Variables (samma värden som i `.env`): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service_role), `DISCORD_WEBHOOK_PUMP_GITHUB`, `GITHUB_TOKEN`, ev. `TWITTERAPI_IO_KEY`
  5. Settings → Serverless / App Sleeping **av**. Replicas = 1
  6. Logs ska visa `pump-github live` och `Prenumererar på nya tokens.`
  7. Stoppa den lokala processen (Ctrl+C) — annars kör två klienter
  8. PC kan stängas av. Push till `main` redeployar automatiskt

## 9. News Watch Scanner (Google News → #news-plays)
- [ ] Skapa textkanalerna `#news-watchlist` och `#news-plays`
- [ ] `#news-plays` → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL
  - Spara som `DISCORD_WEBHOOK_NEWS` lokalt och som GitHub Actions-secret
- [ ] Ge den befintliga boten rättigheterna View Channel, Read Message History och Send Messages i `#news-watchlist`
- [ ] Discord User Settings → Advanced → Developer Mode → högerklicka `#news-watchlist` → Copy Channel ID
  - Spara som `CHANNEL_NEWS_WATCHLIST_ID` lokalt och som GitHub Actions-secret
- [ ] Supabase SQL Editor → kör sektionen `News Watch Scanner` från `supabase/schema.sql`
- [ ] GitHub → Settings → Secrets and variables → Actions → lägg till:
  - `DISCORD_WEBHOOK_NEWS`
  - `CHANNEL_NEWS_WATCHLIST_ID`
  - Befintliga `DISCORD_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `SUPABASE_URL` och `SUPABASE_SERVICE_KEY` återanvänds
- [ ] GitHub → Actions → `news-scan` → Run workflow
- [ ] Skriv ämnen i `#news-watchlist`: `add Elon Musk`, `add AI robots`, `add weird animal news`
- [ ] Kommandon: `list`, `remove <ämne>`, `analyze https://...`
- [ ] Kör workflowet manuellt en gång till. Därefter kör det varje timme och postar högst fem fynd med score 65+.

### X-copy från dina egna exempel
- [ ] Skapa `#news-examples` under Discord-kategorin NEWS
- [ ] Ge befintliga botten View Channel, Read Message History och Send Messages i kanalen
- [ ] Högerklicka kanalen → Copy Channel ID → GitHub Actions-secret `CHANNEL_NEWS_EXAMPLES_ID`
- [ ] Supabase SQL Editor → kör `news_examples` + `alter table news_articles ... ready_post` från `supabase/schema.sql`
- [ ] Posta 5–20 rena stilexempel i detta format:
  ```text
  ARTICLE:
  https://...

  NAME:
  Coin Name

  TICKER:
  $TICKER

  POST:
  Exakt X-inlägg med riktiga radbrytningar.
  ```
- [ ] Actions → `news-scan` → Run workflow. Botten ska svara `Saved example #...`
- [ ] Nya kvalificerade fynd i `#news-plays` får därefter ett `READY TO POST`-block

## 10. Kör GitHub + News varje timme via Railway

GitHub Actions-cron är best effort och kan försenas eller tappas. Railway Hobby kan
köra båda som separata Cron Services. Den befintliga `pump-github`-servicen ska
fortsätta vara en egen, alltid aktiv service.

### Innan Railway-cron aktiveras

- [ ] Supabase → SQL Editor → kör **hela senaste** `supabase/schema.sql`
- [ ] Kontrollera att SQL-körningen är grön utan fel
- [ ] Kontrollera att befintlig Railway-service visar startkommandot
  `npm run pump-github`
- [ ] Låt dess befintliga `/railway.json` vara kvar tills en separat, kontrollerad
  IaC-migration görs. Den gamla Config-as-Code-filen är deprecated men fungerar
  för den redan anslutna servicen till Railways hard cutoff 2026-12-01.

### Ny service: github-scan

1. Railway → öppna samma projekt som `pump-github`
2. `New` → skapa en service från samma GitHub-repo (`Lunkev/Github`, branch `main`)
3. Döp den till `github-scan`
4. Lämna **Config as Code tomt**; `railway.json`/`railway.toml` är deprecated
   och nya services ska inte anslutas till dem
5. Settings → Deploy → Custom Start Command: `npm run github`
6. Settings → Cron Schedule: `10 * * * *`
7. Kontrollera att Source Repo är `Lunkev/Github` och branch `main`, sedan redeploya
8. Lägg in eller referera projektets Shared Variables:
   - `ANTHROPIC_API_KEY`
   - `DISCORD_WEBHOOK_URL`
   - `DISCORD_WEBHOOK_MAYBE`
   - `DISCORD_BOT_TOKEN`
   - `CHANNEL_PROVEN_ID`
   - `CHANNEL_WATCHLIST_ID`
   - `GITHUB_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - valfritt `GITHUB_CLAUDE_MONTHLY_BUDGET_USD=65`
   - valfritt `GITHUB_RUN_DEADLINE_MINUTES=22`
9. Kör en manuell deployment. Loggen ska avslutas med `Klart:` och processen ska
   avslutas; den får inte visa `pump-github live`

### Ny service: news-scan

1. Skapa ytterligare en service från samma repo och döp den till `news-scan`
2. Lämna **Config as Code tomt**
3. Settings → Deploy → Custom Start Command: `npm run news`
4. Settings → Cron Schedule: `17 * * * *`
5. Kontrollera Source Repo `Lunkev/Github`, branch `main`, och redeploya
6. Lägg in eller referera:
   - `ANTHROPIC_API_KEY`
   - `DISCORD_WEBHOOK_NEWS`
   - `DISCORD_BOT_TOKEN`
   - `CHANNEL_NEWS_WATCHLIST_ID`
   - `CHANNEL_NEWS_EXAMPLES_ID`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
7. Kör manuellt. Loggen ska visa `Aktiva ämnen:` och sedan avslutas normalt

### Verifiera och växla över

1. Låt Railway och GitHub Actions överlappa under högst en testtimme
2. Railway Deployments ska visa `github-scan` runt minut `:10` och `news-scan`
   runt minut `:17` (UTC; några minuters avvikelse är normalt)
3. Kontrollera att båda är färdiga långt före nästa heltimme. Railway hoppar över
   nästa körning om föregående fortfarande lever
4. GitHub → Settings → Secrets and variables → Actions → fliken Variables
5. Skapa repository variable:
   - Name: `RUN_SCHEDULED_SCANNERS_ON_GITHUB`
   - Value: `false`
6. Schemalagda GitHub Actions-jobb blir därefter skipped, men `Run workflow`
   fortsätter fungera manuellt

### Rollback

1. Sätt `RUN_SCHEDULED_SCANNERS_ON_GITHUB=true` eller radera variabeln
2. Pausa Railway-servicerna `github-scan` och `news-scan`
3. GitHub Actions kör åter automatiskt varje timme

Railway Hobby kostar minst $5/mån och inkluderar $5 resursanvändning. De två
kortlivade cron-jobben kan ge några dollars överkostnad om den permanenta
Pump-servicen redan använder krediten. Claude-kostnaden är oförändrad.
