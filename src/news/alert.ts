import { config, hasKey } from "../config.js";
import { postWebhook } from "../discord/webhook.js";
import type { NewsArticle, NewsCandidate } from "./types.js";

const ALERT_THRESHOLD = 65;
const MAX_ALERTS = 5;

function ticker(value: string): string {
  const clean = value.trim();
  return clean.startsWith("$") ? clean : `$${clean}`;
}

export function formatNewsPlay(candidate: NewsCandidate, article: NewsArticle): string {
  const readyPost = candidate.readyPost.replace(/```/g, "'''");
  return [
    `NEWS PLAY · ${candidate.score}/100 · ${candidate.category}`,
    "",
    `${ticker(candidate.tickerSuggestion)} — ${candidate.nameSuggestion}`,
    "",
    article.title,
    `Source: ${article.sourceName}`,
    "",
    candidate.narrative,
    `Angle: ${candidate.angle}`,
    `Why now: ${candidate.whyNow}`,
    "",
    "READY TO POST",
    "```",
    readyPost,
    "```",
    "",
    article.url,
  ].join("\n");
}

/** Postar aldrig till gems-webhooken. Returnerar fingerprints som försökte alertas. */
export async function sendNewsAlerts(
  candidates: NewsCandidate[],
  articles: NewsArticle[],
): Promise<Set<string>> {
  const alerted = new Set<string>();
  const articleByFingerprint = new Map(articles.map((article) => [article.fingerprint, article]));
  const selected = candidates.filter((candidate) => candidate.score >= ALERT_THRESHOLD).slice(0, MAX_ALERTS);

  if (!hasKey.discordNews()) {
    if (selected.length > 0) console.error("Ingen DISCORD_WEBHOOK_NEWS — postar inte news-fynd.");
    return alerted;
  }

  for (const candidate of selected) {
    const article = articleByFingerprint.get(candidate.articleFingerprint);
    if (!article) continue;
    await postWebhook(config.discordWebhookNews, formatNewsPlay(candidate, article));
    alerted.add(candidate.articleFingerprint);
  }
  return alerted;
}
