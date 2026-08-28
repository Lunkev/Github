# narrative-scanner

Hittar memecoin-narrativ innan de blir coins. Se **PLAN.md** för hela specen och **CLAUDE.md** för AI-assistent-kontext i Cursor.

## Snabbstart

```bash
npm install
cp .env.example .env        # fyll i nycklar (allt är valfritt utom för full funktion)
npm run scan -- --dry       # torrkörning: bara insamling, inga nycklar krävs
npm run scan                # skarp: insamling -> Claude-scoring -> Discord-brief -> DB
npm run typecheck
```

## Nycklar (allt i .env / GitHub secrets)

| Nyckel | Krävs för | Var |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI-scoring | console.anthropic.com |
| `DISCORD_WEBHOOK_URL` | Briefen | Discord: Server Settings → Integrations → Webhooks |
| `TWITTERAPI_IO_KEY` | X-trender/KOLs | twitterapi.io (pay-per-call) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Historik + proven coins | supabase.com (kör `supabase/schema.sql`) |
| `APIFY_TOKEN` | TikTok (v2) | apify.com |

## Cron

Pusha till GitHub → `.github/workflows/daily.yml` kör skanningen 07:00 / 13:00 / 19:00 svensk tid. Lägg nycklarna som repo-secrets. Manuell körning: Actions-fliken → narrative-scan → Run workflow.
