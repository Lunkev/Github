// Orchestrator: samla signaler -> scora med Claude -> skicka Discord-brief -> spara i DB.
// Körs av GitHub Actions-cron eller manuellt: `npm run scan` (lägg till `-- --dry` för torrkörning).
import { config } from "./config.js";
import { fetchRssNews } from "./sources/rssNews.js";
import { fetchHackerNews } from "./sources/hackerNews.js";
import { fetchGoogleTrends } from "./sources/googleTrends.js";
import { fetchReddit } from "./sources/reddit.js";
import { fetchTwitter } from "./sources/twitter.js";
import { fetchTikTok } from "./sources/tiktok.js";
import { fetchTrendingTokens } from "./provenCoins/dexscreener.js";
import { scoreNarratives } from "./analyze/scoreNarratives.js";
import { sendDiscordBrief } from "./report/discord.js";
import { saveScan, getProvenPatterns } from "./db/supabase.js";
import type { Signal } from "./types.js";

const DRY = process.argv.includes("--dry");

async function main() {
  console.log(`🔍 narrative-scanner ${DRY ? "(torrkörning)" : ""} — ${new Date().toISOString()}\n`);

  // 1. Samla alla källor parallellt — en trasig källa fäller aldrig helheten.
  const [rss, hn, trends, reddit, twitter, tiktok, dex] = await Promise.all([
    fetchRssNews(config.freshnessHours),
    fetchHackerNews(config.freshnessHours),
    fetchGoogleTrends(),
    fetchReddit(),
    fetchTwitter(),
    fetchTikTok(),
    fetchTrendingTokens(),
  ]);

  const signals: Signal[] = [...rss, ...hn, ...trends, ...reddit, ...twitter, ...tiktok, ...dex];
  const bySource = signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.source] = (acc[s.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log("Signaler insamlade:", bySource, `(totalt ${signals.length})\n`);

  if (DRY) {
    for (const s of signals.slice(0, 40)) console.log(`  · [${s.source}] ${s.title.slice(0, 100)}`);
    console.log(`\n✅ Torrkörning klar. ${signals.length} signaler. Kör utan --dry för scoring + brief.`);
    return;
  }

  // 2. Hämta bevisade mönster (tomt tills DB finns) och scora med Claude.
  const provenPatterns = await getProvenPatterns();
  const candidates = await scoreNarratives(signals, provenPatterns);
  console.log(`Claude hittade ${candidates.length} kandidater.`);

  // 3. Leverera + spara.
  await sendDiscordBrief(candidates);
  await saveScan(signals, candidates);
  console.log("✅ Klart.");
}

main()
  .then(() => process.exit(0)) // hängande sockets ska inte hålla cron-jobbet vid liv
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
