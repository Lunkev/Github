# Narrative Scanner — Plan & Spec

> Proaktivt system som hittar memecoin-narrativ INNAN de blir coins — från X-trender, nyheter, virala TikToks och AI-tech-nyheter — plus en växande databas av bevisade coins som mönsterbibliotek.

## 1. Varför detta funkar (och ärlig risk)

Metan har skiftat: traders handlar narrativ (breaking news, virala klipp, AI-släpp) snabbare än klassiska meme-sajter hinner byggas. Fördelen ligger alltså i **informationsövertag + hastighet**: se signalen tidigt, verifiera att ingen coin redan finns, launcha med rätt vinkel.

Ärligt: inget system garanterar vinnare — de flesta launches dör oavsett. Det detta system ger är (a) fler bra tillfällen upptäckta tidigare, (b) färre bortkastade launches på döda narrativ, (c) ett minne av vad som historiskt funkat. Det är ett research-verktyg, inte en pengamaskin.

Detta är ett **eget system**, separat från coin-agent. coin-agent tittar NEDSTRÖMS (pump.fun-migrationer = coins som redan finns). Narrative Scanner tittar UPPSTRÖMS (världen innan coinen finns). De kompletterar varandra och kan dela Discord-server.

## 2. Systemet i tre delar

```
[A] SIGNAL-INSAMLING          [B] AI-ANALYS                [C] LEVERANS + MINNE
 X-trender/sökningar     →     Claude poängsätter     →     Discord daglig brief
 Nyhets-RSS + HN               varje kandidat:              (topp 5–10 narrativ,
 Google Trends                 - narrativ-styrka            ticker-förslag, vinkel)
 Reddit rising                 - velocity (hur snabbt?)
 TikTok-trender                - memeability                proven_coins-databas
 DexScreener (vad              - crowdedness (finns         (facit: vad funkade,
 pumpar just nu?)                coin redan? → skippa)      vilket narrativ, hur
                               - timing-fönster             högt gick den)
```

### [A] Källor — billigast först

| Källa | Vad den ger | Kostnad |
|---|---|---|
| **Nyhets-RSS** (Reuters, AP, BBC, TechCrunch, The Verge, CoinDesk, Decrypt) | Breaking news, AI-tech-nyheter | Gratis |
| **Hacker News API** | AI/tech-släpp innan de blir mainstream | Gratis |
| **Google Trends RSS** (trending now, US) | Vad världen googlar just nu = bekräftad viralitet | Gratis |
| **Reddit JSON** (r/all rising, r/OutOfTheLoop, r/memes, r/CryptoCurrency) | Memes + "varför trendar X?"-frågor = tidig signal | Gratis |
| **DexScreener API** (trending/boosted + sök) | Vad pumpar NU + crowdedness-koll ("finns coin på detta narrativ redan?") | Gratis |
| **X via twitterapi.io** | Trender, sökningar på kandidat-keywords, KOL-bevakning (Elon m.fl.) | Pay-per-call, ~$5–20/mån vid 2–3 skanningar/dag |
| **TikTok via Apify** (trends-scraper) | Virala videos/hashtags — svåraste källan, alla API:er är scrapers | ~$5–15/mån, valbar i v2 |

Uppskattad totalkostnad: **~$10–40/mån** (inkl. Claude API för scoring). Väl under taket, och allt utom X/TikTok är gratis — så v1 kan köras nästan helt utan kostnad.

### [B] AI-analys — den dagliga deep searchen

Körs 2–3 ggr/dag (cron via GitHub Actions = gratis compute):

1. **Samla** rådata från alla källor (senaste 6–12h).
2. **Korsreferera**: samma ämne i 2+ källor (t.ex. TikTok + Google Trends + Reddit) = stark signal. Velocity mäts som mentions/timme, stigande eller fallande.
3. **Crowdedness-koll**: sök DexScreener på kandidatens keywords. Finns redan en coin med volym → antingen skippa eller flagga "sent, men CTO-vinkel möjlig". Finns INGEN → grön flagga.
4. **Claude scorar** varje kandidat 0–100 på: narrativ-styrka, memeability (går det att göra en rolig ticker/bild?), timing (peakar det om 2h eller 2 dagar?), crowdedness, och matchning mot mönster i proven_coins-databasen.
5. **Output per kandidat**: narrativ i en mening, föreslagen ticker + namn (gärna din formel: verklig händelse + absurd invertering), vinkel/bild-idé, källänkar, score, "varför nu".

### [C] Proven coins-databasen — killer-featuren

Varje dag sparas: dagens topp-narrativ, om coins launchades på dem (via DexScreener-sök nästa dag), och hur de gick (mcap efter 24h / 7d). Över tid växer ett facit:

- Vilka narrativ-TYPER träffar (djur-virals? Elon-tweets? AI-släpp? rättegångar? sport?)
- Hur snabbt fönstret stänger per typ
- Vilka ticker-mönster vinner (felstavningar, inversioner, etc.)

Detta matas tillbaka in i Claudes scoring-prompt → systemet blir smartare varje vecka. Du kan också manuellt lägga in historiska vinnare du känner till som startdata.

## 3. Idébank: vinklar för narrativ-jakt

- **News inversion** (din formel): verklig händelse + absurd twist, launcha inom timmar.
- **First-mover på breaking news**: kändisdöd/RIP, rättegångsdomar, politiska klipp, sporthändelser, rymdlanseringar.
- **AI-metan**: varje stor modell-release, AI-demo som går viralt, robotvideos — HN + TechCrunch fångar dessa tidigt.
- **Djur/varelse-virals**: TikTok-djur, zoo-nyheter, "creature of the week" — historiskt starkaste kategorin.
- **"Varför trendar X?"**: r/OutOfTheLoop och Google Trends fångar exakt ögonblicket något bryter ut ur sin bubbla.
- **KOL-bevakning**: lista med ~20 konton (Elon, stora meme-konton, crypto-KOLs) — en enda post kan vara hela narrativet.
- **Cross-platform-bekräftelse som regel**: 1 källa = brus, 2+ källor inom 12h = kandidat.

## 4. Teknisk arkitektur

- **Språk**: TypeScript/Node (samma värld som din Cursor/Vercel-vana).
- **Compute**: GitHub Actions cron (gratis) — inga servrar. Kan flyttas till Railway senare om du vill ha websockets.
- **DB**: Supabase (samma som coin-agent, men eget projekt/schema): `signals`, `narratives`, `proven_coins`, `daily_briefs`.
- **AI**: Claude API (Haiku för bulk-filtrering, Sonnet för den dagliga deep-scoringen = billigt).
- **Leverans**: Discord webhook — rik embed med topp-narrativ kl 07:00 + intradag-alerts när något scorar >85.

## 5. Roadmap

- **v0 (idag)**: Detta skelett — gratis-källorna funkar direkt, Claude-scoring och Discord-brief kopplas in med dina nycklar.
- **v1 (vecka 1 i Cursor)**: Supabase-schema live, twitterapi.io inkopplad, daglig cron igång.
- **v2**: TikTok via Apify, intradag-alerts, crowdedness-koll skarp.
- **v3**: Feedback-loopen — automatisk uppföljning av gårdagens narrativ mot DexScreener, proven_coins fylls på.
- **v4 (valfritt)**: Dashboard-sida med historik och sökbart mönsterbibliotek.

## 6. Setup-checklista (i Cursor)

1. `npm install`
2. Kopiera `.env.example` → `.env`, fyll i: `ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL` (skapa i din server), ev. `TWITTERAPI_IO_KEY`, `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
3. Kör Supabase-schemat: `supabase/schema.sql` i SQL-editorn
4. Testa lokalt: `npm run scan -- --dry` (kör utan DB/Discord, printar i terminalen)
5. Skarpt: `npm run scan`
6. Pusha till GitHub → cron i `.github/workflows/daily.yml` tar över (lägg in secrets i repo-settings)
