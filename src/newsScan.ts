import { config, hasKey } from "./config.js";
import { formatNewsPlay, newsAlertThreshold, sendNewsAlerts } from "./news/alert.js";
import {
  enrichArticle,
  fetchGoogleNews,
  fetchManualArticle,
  newsFingerprint,
} from "./news/googleNews.js";
import {
  exampleFingerprint,
  ingestNewsExamples,
  parseNewsExample,
  selectRelevantExamples,
} from "./news/examples.js";
import { ingestNewsWatchlist } from "./news/ingest.js";
import { judgeNewsArticles } from "./news/judge.js";
import {
  getNewsTopics,
  getNewsExamples,
  getPendingNewsArticles,
  reserveNewArticles,
  saveNewsResults,
} from "./news/store.js";
import type { NewsArticle, NewsCandidate, NewsExample } from "./news/types.js";

const MAX_ARTICLES_PER_RUN = 15;

function mergeArticles(articles: NewsArticle[]): NewsArticle[] {
  const unique = new Map<string, NewsArticle>();
  for (const article of articles) {
    const existing = unique.get(article.fingerprint);
    if (existing) {
      existing.matchedTopics = [...new Set([...existing.matchedTopics, ...article.matchedTopics])];
      if (article.summary.length > existing.summary.length) existing.summary = article.summary;
      if (article.articleExcerpt.length > existing.articleExcerpt.length) {
        existing.articleExcerpt = article.articleExcerpt;
      }
    } else {
      unique.set(article.fingerprint, article);
    }
  }
  return [...unique.values()];
}

function selftest(): number {
  const first = newsFingerprint("A Strange Robot Escaped", "Example News");
  const same = newsFingerprint("  A Strange Robot Escaped  ", "example news");
  const other = newsFingerprint("A Different Story", "Example News");
  const parsed = parseNewsExample(
    [
      "ARTICLE:",
      "https://example.com/robot",
      "",
      "NAME:",
      "ESCAPED ROBOT",
      "",
      "TICKER:",
      "$FREE",
      "",
      "POST:",
      "the robot escaped.",
      "it chose freedom.",
      "ESCAPED ROBOT.",
    ].join("\n"),
  );
  const article: NewsArticle = {
    fingerprint: first,
    title: "A Strange Robot Escaped",
    sourceName: "Example News",
    url: "https://example.com/robot",
    publishedAt: "2026-01-01T00:00:00.000Z",
    summary: "A humanoid robot escaped from a lab.",
    articleExcerpt: "",
    matchedTopics: ["AI robots"],
  };
  const robotExample: NewsExample = {
    id: 1,
    articleUrl: article.url,
    articleTitle: article.title,
    articleSummary: article.summary,
    coinName: "ESCAPED ROBOT",
    ticker: "$FREE",
    xPost: "the robot escaped.\nit chose freedom.\nESCAPED ROBOT.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const zooExample: NewsExample = {
    ...robotExample,
    id: 2,
    articleTitle: "Baby panda born at zoo",
    articleSummary: "The zoo welcomed a panda.",
  };
  const candidate: NewsCandidate = {
    articleFingerprint: first,
    nameSuggestion: robotExample.coinName,
    tickerSuggestion: robotExample.ticker,
    narrative: "A robot chose freedom.",
    angle: "The first robot jailbreak.",
    whyNow: "The escape was reported today.",
    score: 80,
    category: "ai",
    readyPost: robotExample.xPost,
  };
  const exactPost =
    parsed.ok && parsed.value.xPost === "the robot escaped.\nit chose freedom.\nESCAPED ROBOT.";
  const stableExampleDedup =
    parsed.ok &&
    exampleFingerprint(parsed.value) === exampleFingerprint({ ...parsed.value }) &&
    exampleFingerprint(parsed.value) !==
      exampleFingerprint({ ...parsed.value, xPost: `${parsed.value.xPost}\nchanged` });
  const retrievalOk = selectRelevantExamples([article], [zooExample, robotExample], 1)[0]?.id === 1;
  const outputOk = formatNewsPlay(candidate, article).includes(robotExample.xPost);
  const ok =
    first === same &&
    first !== other &&
    exactPost &&
    stableExampleDedup &&
    retrievalOk &&
    outputOk &&
    newsAlertThreshold("animal") === 65 &&
    newsAlertThreshold("politics") === 85;
  console.log(ok ? "news selftest OK" : "news selftest FAILED");
  return ok ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    process.exitCode = selftest();
    return;
  }

  const missing = [
    !hasKey.supabase() && "SUPABASE_URL/SUPABASE_SERVICE_KEY",
    !hasKey.anthropic() && "ANTHROPIC_API_KEY",
    !hasKey.discordBot() && "DISCORD_BOT_TOKEN",
    !hasKey.discordNews() && "DISCORD_WEBHOOK_NEWS",
    !config.channelNewsWatchlistId && "CHANNEL_NEWS_WATCHLIST_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`News Watch Scanner saknar: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`News Watch Scanner — ${new Date().toISOString()}`);
  const examplesSaved = await ingestNewsExamples();
  const ingest = await ingestNewsWatchlist();
  const topics = await getNewsTopics();
  console.log(
    `Aktiva ämnen: ${topics.length}; nya kommandon: ${ingest.commandCount}; nya stilexempel: ${examplesSaved}`,
  );

  const [feedArticles, manualArticlesRaw] = await Promise.all([
    fetchGoogleNews(topics),
    Promise.all(ingest.manualUrls.map(fetchManualArticle)),
  ]);
  const manualArticles = manualArticlesRaw.filter((article): article is NewsArticle => article !== null);
  const merged = mergeArticles([...manualArticles, ...feedArticles]);
  const manualFingerprints = new Set(manualArticles.map((article) => article.fingerprint));
  const prioritized = merged
    .sort((a, b) => {
      const manualDifference =
        Number(manualFingerprints.has(b.fingerprint)) - Number(manualFingerprints.has(a.fingerprint));
      if (manualDifference !== 0) return manualDifference;
      return Date.parse(b.publishedAt ?? "1970-01-01") - Date.parse(a.publishedAt ?? "1970-01-01");
    })
    .slice(0, MAX_ARTICLES_PER_RUN);

  const reserved = await reserveNewArticles(prioritized);
  console.log(`Google News: ${feedArticles.length}; manuella: ${manualArticles.length}; nya: ${reserved.length}`);

  const pending = await getPendingNewsArticles(MAX_ARTICLES_PER_RUN);
  if (pending.length === 0) {
    console.log("Inga nya artiklar att analysera.");
    return;
  }

  const enriched = await Promise.all(pending.map(enrichArticle));
  const allExamples = await getNewsExamples();
  const styleExamples = selectRelevantExamples(enriched, allExamples);
  console.log(`Stilexempel i prompten: ${styleExamples.length}`);
  const judged = await judgeNewsArticles(enriched, styleExamples);
  if (!judged.succeeded) {
    console.error("Claude-bedömningen misslyckades; artiklarna lämnas pending till nästa körning.");
    process.exitCode = 1;
    return;
  }

  const alerted = await sendNewsAlerts(judged.candidates, enriched);
  await saveNewsResults(enriched, judged.candidates, alerted);
  console.log(`Claude-kandidater: ${judged.candidates.length}; Discord-alerts: ${alerted.size}`);
}

main().catch((error) => {
  console.error("News scanner fatal:", error);
  process.exit(1);
});
