import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import type { NewsArticle, NewsCandidate, NewsExample } from "./types.js";

const CandidateSchema = z.object({
  articleIndex: z.number().int().nonnegative(),
  nameSuggestion: z.string().min(1),
  tickerSuggestion: z.string().min(1),
  narrative: z.string().min(1),
  angle: z.string().min(1),
  whyNow: z.string().min(1),
  score: z.number().min(0).max(100),
  category: z.string().min(1),
  readyPost: z.string().min(1).max(1_500),
});
const ResponseSchema = z.object({ candidates: z.array(CandidateSchema) });

export interface NewsJudgeResult {
  succeeded: boolean;
  candidates: NewsCandidate[];
}

export async function judgeNewsArticles(
  articles: NewsArticle[],
  styleExamples: NewsExample[],
): Promise<NewsJudgeResult> {
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

  const exampleText = styleExamples.length
    ? styleExamples
        .map((example, index) =>
          [
            `EXAMPLE ${index + 1}`,
            `Article: ${example.articleTitle || example.articleUrl}`,
            example.articleSummary ? `Article context: ${example.articleSummary.slice(0, 700)}` : "",
            `Coin: ${example.coinName} (${example.ticker})`,
            "Exact X post:",
            example.xPost.slice(0, 1_200),
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")
    : "(No Kevin style examples saved yet. Use the concise fallback rules below.)";

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

KEVIN'S STYLE EXAMPLES:
These are exact article → coin → X-post examples. Learn their rhythm, clarity, line breaks, slang, capitalization, and how they connect a news fact to the coin. Do not copy their facts or names.

${exampleText}

READY POST RULES:
- Produce exactly one readyPost per candidate, ready to paste directly into X.
- Make the news understandable immediately, then connect it naturally to the coin name/ticker.
- Prefer a short post with 2-6 readable, punchy lines. Straight to the point; clarity beats cleverness.
- Usually stay near ordinary short-post length. Only go longer when the style examples clearly justify it.
- Use only facts stated in the supplied article context. If context is too thin, reject the candidate.
- No hashtags, markdown, surrounding quotes, generic AI language, invented facts, contract address, or instructions to the user.
- The examples control tone and formatting; the fallback is concise, direct, and human.

ARTICLES:
${articleText}

Return ONLY valid JSON:
{"candidates":[{"articleIndex":0,"nameSuggestion":"...","tickerSuggestion":"$...","narrative":"one clear sentence","angle":"the concrete meme/launch angle","whyNow":"why the timing is live now","score":0,"category":"breaking-news|celebrity|animal|tech|ai|politics|crime|culture|sports|other","readyPost":"exact ready-to-paste X copy with line breaks"}]}`;

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
        readyPost: candidate.readyPost.trim(),
      }))
      .sort((a, b) => b.score - a.score);
    return { succeeded: true, candidates };
  } catch (error) {
    console.error("News judge:", error instanceof Error ? error.message : error);
    return { succeeded: false, candidates: [] };
  }
}
