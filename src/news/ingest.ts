import { config, hasKey } from "../config.js";
import { getState, setState } from "../db/githubStore.js";
import { addNewsTopic, getNewsTopics, removeNewsTopic } from "./store.js";

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean; username: string };
}

export interface NewsIngestResult {
  manualUrls: string[];
  commandCount: number;
}

async function fetchNewMessages(afterId: string | null): Promise<DiscordMessage[]> {
  if (!hasKey.discordBot() || !config.channelNewsWatchlistId) return [];
  const after = afterId ? `&after=${afterId}` : "";
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${config.channelNewsWatchlistId}/messages?limit=100${after}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.error(`News-watchlist kunde inte läsas: Discord ${res.status}`);
      return [];
    }
    const messages = (await res.json()) as DiscordMessage[];
    return messages.filter((message) => !message.author.bot).reverse();
  } catch (error) {
    console.error("News-watchlist:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function reply(content: string): Promise<void> {
  if (!hasKey.discordBot() || !config.channelNewsWatchlistId) return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${config.channelNewsWatchlistId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${config.discordBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: content.slice(0, 1990) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) console.error(`News-watchlist svar misslyckades: Discord ${res.status}`);
  } catch (error) {
    console.error("News-watchlist svar:", error instanceof Error ? error.message : error);
  }
}

/** Läser add/remove/list/analyze från den separata nyhetskanalen. Aldrig throw. */
export async function ingestNewsWatchlist(): Promise<NewsIngestResult> {
  const stateKey = `last_msg_news_${config.channelNewsWatchlistId}`;
  const messages = await fetchNewMessages(await getState(stateKey));
  const manualUrls: string[] = [];
  let commandCount = 0;

  for (const message of messages) {
    const content = message.content.trim();
    const analyze = content.match(/^analyze\s+(https?:\/\/\S+)/i);
    if (analyze) {
      manualUrls.push(analyze[1]);
      commandCount++;
      await reply(`Queued for analysis: ${analyze[1]}`);
      continue;
    }

    const add = content.match(/^add\s+(.{2,120})$/i);
    if (add) {
      commandCount++;
      const ok = await addNewsTopic(add[1], message.author.username);
      await reply(ok ? `Now watching: **${add[1].trim()}**` : `Could not add: **${add[1].trim()}**`);
      continue;
    }

    const remove = content.match(/^remove\s+(.{2,120})$/i);
    if (remove) {
      commandCount++;
      const ok = await removeNewsTopic(remove[1]);
      await reply(ok ? `Stopped watching: **${remove[1].trim()}**` : `Not found: **${remove[1].trim()}**`);
      continue;
    }

    if (/^list$/i.test(content)) {
      commandCount++;
      const topics = await getNewsTopics();
      await reply(
        topics.length
          ? `Active news topics:\n${topics.map((topic) => `• ${topic}`).join("\n")}`
          : "No active news topics. Add one with `add <topic>`.",
      );
    }
  }

  if (messages.length > 0) await setState(stateKey, messages[messages.length - 1].id);
  return { manualUrls, commandCount };
}
