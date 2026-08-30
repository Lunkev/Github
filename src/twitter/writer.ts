import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import { ageHours } from "./velocity.js";
import type { TokenUsage, TwitterExample, TwitterOrigin } from "./types.js";

const ResponseSchema = z.object({ readyPost: z.string().min(1).max(1_500) });

export async function writeReadyPost(
  origin: TwitterOrigin,
  examples: TwitterExample[],
): Promise<{ readyPost: string | null; usage: TokenUsage; error?: string }> {
  if (!hasKey.anthropic()) return { readyPost: null, usage: { input: 0, output: 0 }, error: "ANTHROPIC_API_KEY saknas" };
  if (!origin.decision?.approved) return { readyPost: null, usage: { input: 0, output: 0 }, error: "Origin är inte godkänd" };
  const proof = `${origin.viewCount.toLocaleString("en-US")} views · ${ageHours(origin).toFixed(1)}h old`;
  const style = examples.length
    ? examples.map((example, index) => [
        `EXAMPLE ${index + 1}`,
        `Origin: ${example.originText.slice(0, 600)}`,
        `Coin: ${example.coinName} (${example.ticker})`,
        example.xPost.slice(0, 1_000),
      ].join("\n")).join("\n\n")
    : "No saved examples. Be concise, direct, human, and factual.";
  const prompt = `Write one ready-to-paste X post for Kevin's manually deployed Solana memecoin.

Use the examples only for voice, rhythm, line breaks and clarity. Never copy their facts or names.
Structure:
1. One strong hype line.
2. Two or three short lines explaining the real origin event.
3. This exact proof line: ${proof}
4. This exact URL on the last line: ${origin.url}

No hashtags, markdown, contract address, invented facts, generic AI wording, or instructions.
Coin: ${origin.decision.coinName} ($${origin.decision.ticker})
Narrative: ${origin.decision.narrative}
Origin by @${origin.author.userName}: ${origin.text}

STYLE EXAMPLES:
${style}

Return ONLY JSON: {"readyPost":"..."}`;
  let usage: TokenUsage = { input: 0, output: 0 };
  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const message = await client.messages.create({
      model: config.twitterClaudeModel,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    usage = { input: message.usage.input_tokens, output: message.usage.output_tokens };
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("Writer returned no JSON");
    const parsed = ResponseSchema.parse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.readyPost.includes(origin.url) || !parsed.readyPost.includes(proof)) {
      throw new Error("Writer utelämnade verifierad proof-rad eller origin-URL");
    }
    return {
      readyPost: parsed.readyPost.trim(),
      usage,
    };
  } catch (error) {
    return {
      readyPost: null,
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
