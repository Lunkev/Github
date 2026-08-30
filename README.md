# narrative-scanner

Hittar memecoin-narrativ innan de blir coins. Se **PLAN.md** för hela specen och **CLAUDE.md** för AI-assistent-kontext i Cursor.

## Snabbstart

```bash
npm install
cp .env.example .env        # fyll i nycklar (allt är valfritt utom för full funktion)
npm run scan -- --dry       # torrkörning: bara insamling, inga nycklar krävs
npm run scan                # skarp: insamling -> Claude-scoring -> Discord-brief -> DB
npm run news                # Discord-styrda Google News-sökningar -> #news-plays
npm run typecheck
```

## Nycklar (allt i .env / GitHub secrets)

| Nyckel | Krävs för | Var |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI-scoring | console.anthropic.com |
| `DISCORD_WEBHOOK_URL` | Briefen | Discord: Server Settings → Integrations → Webhooks |
| `DISCORD_WEBHOOK_NEWS` | News Watch-alerts | Discord-webhook för `#news-plays` |
| `CHANNEL_NEWS_WATCHLIST_ID` | News-kommandon | Kanal-ID för `#news-watchlist` |
| `CHANNEL_NEWS_EXAMPLES_ID` | X-copy-stilexempel | Kanal-ID för `#news-examples` |
| `DISCORD_BOT_TOKEN` | Läsa/svara i watchlist-kanaler | Discord Developer Portal |
| `TWITTERAPI_IO_KEY` | X-trender/KOLs | twitterapi.io (pay-per-call) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Historik + proven coins | supabase.com (kör `supabase/schema.sql`) |
| `APIFY_TOKEN` | TikTok (v2) | apify.com |

## Cron

Pusha till GitHub → `.github/workflows/daily.yml` kör News Watch Scanner varje timme. Lägg nycklarna som repo-secrets. Manuell körning: Actions-fliken → news-scan → Run workflow.
