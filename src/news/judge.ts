import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import type { NewsArticle, NewsCandidate } from "./types.js";

const CandidateSchema = z.object({
  articleIndex: z.number().int().nonnegative(),
  nameSuggestion: z.string().min(1),
  tickerSuggestion: z.string().min(1),
  narrative: z.string().min(1),
  angle: z.string().min(1),
  whyNow: z.string().min(1),
  score: z.number().min(0).max(100),
  category: z.string().min(1),
});
const ResponseSchema = z.object({ candidates: z.array(CandidateSchema) });

export interface NewsJudgeResult {
  succeeded: boolean;
  candidates: NewsCandidate[];
}

export async function judgeNewsArticles(articles: NewsArticle[]): Promise<NewsJudgeResult> {
  if (articles.length === 0) return { succeeded: true, candidates: [] };
  if (!hasKey.anthropic()) {
    console.error("Ingen ANTHROPIC_API_KEY — news-artiklar lämnas pending.");
    return { succeeded: false, candidates: [] };
  }

  const articleText = articles
    .map((article, index) => {
      const context = (article.articleExcerpt || article.summary || "(no excerpt available)").slice(0, 2_200);
      return [
        `[${index}] ${article.title}`,
        `Source: ${article.sourceName}`,
        `Published: ${article.publishedAt ?? "unknown"}`,
        `Matched watch topics: ${article.matchedTopics.join(", ")}`,
        `Context: ${context}`,
        `URL: ${article.url}`,
      ].join("\n");
    })
    .join("\n\n");

  const prompt = `You are a ruthless real-time news analyst for a Solana memecoin deployer.

These are NEW English-language news articles selected by Kevin's watch topics. Find only articles where a fresh, concrete event can become an instantly understandable memecoin play.

Good:
- a bizarre or emotionally charged event, ruling, quote, product release, celebrity moment, animal story, or cultural incident
- a simple joke or absurd inversion that is understood in one second
- a short, memorable name and ticker tied directly to the event
- timing matters now, not a generic evergreen topic

Reject:
- routine market recaps, price predictions, listicles, opinion pieces, SEO filler
- generic politics with no visual or absurd meme angle
- weak word association, forced tickers, or stories already centered on an established coin
- articles whose context does not establish a real event

Score 0-100 for freshness, memeability, clarity, timing, and launchability. Be selective but use medium sensitivity.
Return at most 5 candidates, best first. Include only score >= 50; downstream alerts require >= 65.

ARTICLES:
${articleText}

Return ONLY valid JSON:
{"candidates":[{"articleIndex":0,"nameSuggestion":"...","tickerSuggestion":"$...","narrative":"one clear sentence","angle":"the concrete meme/launch angle","whyNow":"why the timing is live now","score":0,"category":"breaking-news|celebrity|animal|tech|ai|politics|crime|culture|sports|other"}]}`;

  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2_500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("Claude returned no JSON object");
    const parsed = ResponseSchema.parse(JSON.parse(text.slice(start, end + 1)));
    const seenArticles = new Set<number>();
    const candidates = parsed.candidates
      .filter((candidate) => candidate.articleIndex < articles.length)
      .filter((candidate) => {
        if (seenArticles.has(candidate.articleIndex)) return false;
        seenArticles.add(candidate.articleIndex);
        return true;
      })
      .map((candidate): NewsCandidate => ({
        articleFingerprint: articles[candidate.articleIndex].fingerprint,
        nameSuggestion: candidate.nameSuggestion.trim(),
        tickerSuggestion: candidate.tickerSuggestion.trim(),
        narrative: candidate.narrative.trim(),
        angle: candidate.angle.trim(),
        whyNow: candidate.whyNow.trim(),
        score: candidate.score,
        category: candidate.category.trim(),
      }))
      .sort((a, b) => b.score - a.score);
    return { succeeded: true, candidates };
  } catch (error) {
    console.error("News judge:", error instanceof Error ? error.message : error);
    return { succeeded: false, candidates: [] };
  }
}
