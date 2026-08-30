import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import type { TokenUsage, TwitterDecision, TwitterOrigin } from "./types.js";

const DecisionSchema = z.object({
  tweetId: z.string().min(1),
  approved: z.boolean(),
  score: z.number().min(0).max(100),
  coinName: z.string(),
  ticker: z.string(),
  narrative: z.string(),
  category: z.string(),
  reasoning: z.string(),
});
const ResponseSchema = z.object({ decisions: z.array(DecisionSchema) });

export interface JudgeResult {
  succeeded: boolean;
  decisions: Map<string, TwitterDecision>;
  usage: TokenUsage;
  error?: string;
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export async function judgeOrigins(origins: TwitterOrigin[]): Promise<JudgeResult> {
  if (origins.length === 0) return { succeeded: true, decisions: new Map(), usage: { input: 0, output: 0 } };
  if (!hasKey.anthropic()) return { succeeded: false, decisions: new Map(), usage: { input: 0, output: 0 }, error: "ANTHROPIC_API_KEY saknas" };
  const input = origins.map((origin) => ({
    tweetId: origin.id,
    author: origin.author.userName,
    text: origin.text.slice(0, 2_000),
    createdAt: origin.createdAt,
    views: origin.viewCount,
    velocity: Math.round(origin.observedVelocity ?? origin.approximateVelocity),
    thread: origin.sourceThread.map((tweet) => tweet.text.slice(0, 800)),
    url: origin.url,
  }));
  const prompt = `You are a ruthless real-time X analyst for a Solana memecoin deployer. Kevin always deploys manually.

Approve only fresh, concrete, instantly understandable events with a strong visual, emotional, absurd, person, news, politics, sports, culture, product, AI, animal, or other memecoin angle. The ideal is a real event plus an absurd inversion and immediate execution.

Reject empty reactions, ordinary marketing, crypto shilling, existing coin campaigns, routine product/open-source/infra news, unverifiable stories, forced wordplay, and sexual abuse or graphic harm involving children. AI or product launches require exceptional virality and a direct meme angle.

Judge the resolved origin, not a reaction quoting it. Do not write an X post.
Ticker must be 1-10 A-Z/0-9 characters without $. Coin name must be understood in one second.
Return one decision for every input tweet. Rejected items use empty coinName/ticker but still include narrative/category/reasoning.

INPUT:
${JSON.stringify(input)}

Return ONLY JSON:
{"decisions":[{"tweetId":"...","approved":true,"score":0,"coinName":"...","ticker":"...","narrative":"one sentence","category":"animal|absurd|person|news|politics|sports|culture|product|ai|other","reasoning":"brief"}]}`;
  let usage: TokenUsage = { input: 0, output: 0 };
  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const message = await client.messages.create({
      model: config.twitterClaudeModel,
      max_tokens: 2_000,
      messages: [{ role: "user", content: prompt }],
    });
    usage = { input: message.usage.input_tokens, output: message.usage.output_tokens };
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const parsed = ResponseSchema.parse(parseJson(text));
    const validIds = new Set(origins.map((origin) => origin.id));
    const decisions = new Map<string, TwitterDecision>();
    for (const decision of parsed.decisions) {
      if (!validIds.has(decision.tweetId) || decisions.has(decision.tweetId)) continue;
      const ticker = decision.ticker.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
      decisions.set(decision.tweetId, {
        approved: decision.approved && ticker.length > 0 && decision.coinName.trim().length > 0,
        score: decision.score,
        coinName: decision.coinName.trim(),
        ticker,
        narrative: decision.narrative.trim(),
        category: decision.category.trim(),
        reasoning: decision.reasoning.trim(),
      });
    }
    if (decisions.size !== origins.length) throw new Error("Claude omitted one or more tweet decisions");
    return {
      succeeded: true,
      decisions,
      usage,
    };
  } catch (error) {
    return {
      succeeded: false,
      decisions: new Map(),
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
