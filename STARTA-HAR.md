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
- [ ] `npm run pump-github -- --selftest` sedan `npm run pump-github` (måste vara igång för att fånga launches)
- [ ] För dygnet runt: Railway/Fly/PC — **inte** GitHub Actions eller Vercel
