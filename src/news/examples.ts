import { createHash } from "node:crypto";
import { config, hasKey } from "../config.js";
import { getState, setState } from "../db/githubStore.js";
import { fetchManualArticle } from "./googleNews.js";
import { saveNewsExample } from "./store.js";
import type { NewsArticle, NewsExample } from "./types.js";

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean };
}

export interface ParsedNewsExample {
  articleUrl: string;
  coinName: string;
  ticker: string;
  xPost: string;
}

export type ParseExampleResult =
  | { ok: true; value: ParsedNewsExample }
  | { ok: false; missing: string[] };

function fieldLines(lines: string[], start: number, end: number): string[] {
  const part = lines.slice(start + 1, end);
  while (part.length && part[0].trim() === "") part.shift();
  while (part.length && part[part.length - 1].trim() === "") part.pop();
  return part;
}

/** Deterministisk parser: X-posten skrivs aldrig om och interna radbrytningar bevaras. */
export function parseNewsExample(content: string): ParseExampleResult {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerIndex = (name: string) =>
    lines.findIndex((line) => new RegExp(`^\\s*${name}:\\s*$`, "i").test(line));
  const articleAt = headerIndex("ARTICLE");
  const nameAt = headerIndex("NAME");
  const tickerAt = headerIndex("TICKER");
  const postAt = headerIndex("POST");
  const ordered =
    articleAt >= 0 && articleAt < nameAt && nameAt < tickerAt && tickerAt < postAt;

  if (!ordered) {
    const missing = [
      articleAt < 0 && "ARTICLE",
      nameAt < 0 && "NAME",
      tickerAt < 0 && "TICKER",
      postAt < 0 && "POST",
    ].filter((value): value is string => Boolean(value));
    return { ok: false, missing: missing.length ? missing : ["correct field order"] };
  }

  const articleText = fieldLines(lines, articleAt, nameAt).join("\n").trim();
  const coinName = fieldLines(lines, nameAt, tickerAt).join("\n").trim();
  const tickerRaw = fieldLines(lines, tickerAt, postAt).join("\n").trim();
  const postLines = fieldLines(lines, postAt, lines.length);
  const xPost = postLines.join("\n");
  const url = articleText.match(/https?:\/\/\S+/i)?.[0] ?? "";
  const missing = [
    !url && "valid ARTICLE URL",
    !coinName && "NAME",
    !tickerRaw && "TICKER",
    !xPost && "POST",
  ].filter((value): value is string => Boolean(value));
  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    value: {
      articleUrl: url,
      coinName,
      ticker: tickerRaw.startsWith("$") ? tickerRaw : `$${tickerRaw}`,
      xPost,
    },
  };
}

export function exampleFingerprint(example: ParsedNewsExample): string {
  return createHash("sha256")
    .update(
      [
        example.articleUrl.trim().toLowerCase(),
        example.coinName.trim().toLowerCase(),
        example.ticker.trim().toLowerCase(),
        example.xPost,
      ].join("|"),
    )
    .digest("hex");
}

async function fetchNewMessages(afterId: string | null): Promise<DiscordMessage[]> {
  if (!hasKey.discordBot() || !config.channelNewsExamplesId) return [];
  const after = afterId ? `&after=${afterId}` : "";
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${config.channelNewsExamplesId}/messages?limit=100${after}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.error(`News-examples kunde inte läsas: Discord ${res.status}`);
      return [];
    }
    const messages = (await res.json()) as DiscordMessage[];
    return messages.filter((message) => !message.author.bot).reverse();
  } catch (error) {
    console.error("News-examples:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function reply(content: string): Promise<void> {
  if (!hasKey.discordBot() || !config.channelNewsExamplesId) return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${config.channelNewsExamplesId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: content.slice(0, 1_990) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) console.error(`News-examples svar misslyckades: Discord ${res.status}`);
  } catch (error) {
    console.error("News-examples svar:", error instanceof Error ? error.message : error);
  }
}

export async function ingestNewsExamples(): Promise<number> {
  if (!config.channelNewsExamplesId) return 0;
  const stateKey = `last_msg_news_examples_${config.channelNewsExamplesId}`;
  const messages = await fetchNewMessages(await getState(stateKey));
  let saved = 0;

  for (const message of messages) {
    const parsed = parseNewsExample(message.content);
    if (!parsed.ok) {
      if (/^\s*ARTICLE:/i.test(message.content)) {
        await reply(`Example not saved. Missing: ${parsed.missing.join(", ")}.`);
      }
      continue;
    }

    const article = await fetchManualArticle(parsed.value.articleUrl);
    const result = await saveNewsExample({
      fingerprint: exampleFingerprint(parsed.value),
      articleUrl: parsed.value.articleUrl,
      articleTitle: article?.title ?? "",
      articleSummary: article?.summary ?? "",
      coinName: parsed.value.coinName,
      ticker: parsed.value.ticker,
      xPost: parsed.value.xPost,
      sourceMessage: message.content,
    });
    if (result.error) {
      await reply(`Example not saved: ${result.error}`);
    } else if (result.duplicate) {
      await reply(`Example already saved${result.id ? ` as #${result.id}` : ""}.`);
    } else {
      saved++;
      await reply(`Saved example #${result.id}.`);
    }
  }

  if (messages.length > 0) await setState(stateKey, messages[messages.length - 1].id);
  return saved;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "from", "have", "into", "just", "more", "news",
  "that", "their", "there", "these", "this", "with", "will", "your",
]);

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g)
      ?.filter((word) => !STOP_WORDS.has(word)) ?? [],
  );
}

/** Relevant examples först; senaste exempel bryter lika poäng. */
export function selectRelevantExamples(
  articles: NewsArticle[],
  examples: NewsExample[],
  limit = 20,
): NewsExample[] {
  const articleWords = words(
    articles
      .map((article) => `${article.title} ${article.summary} ${article.articleExcerpt}`)
      .join(" "),
  );
  return examples
    .map((example, index) => {
      const exampleWords = words(`${example.articleTitle} ${example.articleSummary}`);
      let overlap = 0;
      for (const word of exampleWords) if (articleWords.has(word)) overlap++;
      return { example, overlap, index };
    })
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, limit)
    .map(({ example }) => example);
}
