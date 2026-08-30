import { createHash } from "node:crypto";
import { config, hasKey } from "../config.js";
import { getState, setState } from "../db/githubStore.js";
import { getExamples, saveExample } from "./store.js";
import type { TwitterExample, TwitterOrigin } from "./types.js";

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean };
}

export interface ParsedTwitterExample {
  originUrl: string;
  originText: string;
  coinName: string;
  ticker: string;
  xPost: string;
}

export function parseTwitterExample(content: string): ParsedTwitterExample | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const at = (name: string) => lines.findIndex((line) => new RegExp(`^\\s*${name}:\\s*$`, "i").test(line));
  const originAt = at("ORIGIN");
  const nameAt = at("NAME");
  const tickerAt = at("TICKER");
  const postAt = at("POST");
  if (!(originAt >= 0 && originAt < nameAt && nameAt < tickerAt && tickerAt < postAt)) return null;
  const field = (start: number, end: number) => lines.slice(start + 1, end).join("\n").trim();
  const origin = field(originAt, nameAt);
  const originUrl = origin.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\S+\/status\/\d+/i)?.[0] ?? "";
  const coinName = field(nameAt, tickerAt);
  const tickerRaw = field(tickerAt, postAt);
  const xPost = field(postAt, lines.length);
  if (!originUrl || !coinName || !tickerRaw || !xPost) return null;
  return {
    originUrl,
    originText: origin.replace(originUrl, "").trim(),
    coinName,
    ticker: tickerRaw.startsWith("$") ? tickerRaw : `$${tickerRaw}`,
    xPost,
  };
}

export function twitterExampleFingerprint(example: ParsedTwitterExample): string {
  return createHash("sha256")
    .update([example.originUrl.toLowerCase(), example.coinName.toLowerCase(), example.ticker.toLowerCase(), example.xPost].join("|"))
    .digest("hex");
}

async function fetchMessages(afterId: string | null): Promise<DiscordMessage[]> {
  if (!hasKey.discordBot() || !config.channelTwitterExamplesId) return [];
  const after = afterId ? `&after=${afterId}` : "";
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${config.channelTwitterExamplesId}/messages?limit=100${after}`,
      { headers: { Authorization: `Bot ${config.discordBotToken}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return [];
    return ((await response.json()) as DiscordMessage[]).filter((message) => !message.author.bot).reverse();
  } catch {
    return [];
  }
}

async function reply(content: string): Promise<void> {
  if (!config.channelTwitterExamplesId) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${config.channelTwitterExamplesId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${config.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1_990) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* Nästa körning kan läsa meddelandet igen om cursorn inte hann sparas. */
  }
}

export async function ingestTwitterExamples(): Promise<number> {
  const stateKey = `twitter_last_examples_message_${config.channelTwitterExamplesId}`;
  const messages = await fetchMessages(await getState(stateKey));
  let saved = 0;
  for (const message of messages) {
    if (!/^\s*ORIGIN:/i.test(message.content)) continue;
    const parsed = parseTwitterExample(message.content);
    if (!parsed) {
      await reply("Example not saved. Use ORIGIN, NAME, TICKER and POST in that order.");
      continue;
    }
    const result = await saveExample({
      ...parsed,
      fingerprint: twitterExampleFingerprint(parsed),
      sourceMessage: message.content,
    });
    if (result.error) await reply(`Example not saved: ${result.error}`);
    else if (result.duplicate) await reply(`Example already saved${result.id ? ` as #${result.id}` : ""}.`);
    else {
      saved++;
      await reply(`Saved example #${result.id}.`);
    }
  }
  if (messages.length > 0) await setState(stateKey, messages.at(-1)!.id);
  return saved;
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

export function selectRelevantExamples(origin: TwitterOrigin, examples: TwitterExample[], limit = 20): TwitterExample[] {
  const originWords = words(origin.text);
  return examples
    .map((example, index) => {
      let overlap = 0;
      for (const word of words(example.originText)) if (originWords.has(word)) overlap++;
      return { example, overlap, index };
    })
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, limit)
    .map(({ example }) => example);
}

export { getExamples };
