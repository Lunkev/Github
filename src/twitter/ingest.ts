import { config, hasKey } from "../config.js";
import { getState, setState } from "../db/githubStore.js";
import { addQuery, listQueries, setQueryActive } from "./store.js";

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean; username: string };
}

async function fetchMessages(afterId: string | null): Promise<DiscordMessage[]> {
  if (!hasKey.discordBot() || !config.channelTwitterWatchlistId) return [];
  const after = afterId ? `&after=${afterId}` : "";
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${config.channelTwitterWatchlistId}/messages?limit=100${after}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      console.error(`Twitter-watchlist Discord ${response.status}`);
      return [];
    }
    const messages = (await response.json()) as DiscordMessage[];
    return messages.filter((message) => !message.author.bot).reverse();
  } catch (error) {
    console.error("Twitter-watchlist:", error instanceof Error ? error.message : error);
    return [];
  }
}

async function reply(content: string): Promise<void> {
  if (!config.channelTwitterWatchlistId) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${config.channelTwitterWatchlistId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: content.slice(0, 1_990) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Twitter-watchlist svar:", error instanceof Error ? error.message : error);
  }
}

export async function ingestTwitterWatchlist(): Promise<number> {
  const stateKey = `twitter_last_watchlist_message_${config.channelTwitterWatchlistId}`;
  const messages = await fetchMessages(await getState(stateKey));
  let commands = 0;

  for (const message of messages) {
    const lines = message.content.replace(/```[a-z]*|```/gi, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const content of lines) {
      const add = content.match(/^add\s+(.{2,500})$/i);
      if (add) {
        commands++;
        await reply(
          (await addQuery(add[1], message.author.username))
            ? `Watching: **${add[1]}**`
            : `Could not add: **${add[1]}**`,
        );
        continue;
      }
      const action = content.match(/^(remove|pause|resume)\s+(.{1,500})$/i);
      if (action) {
        commands++;
        const active = action[1].toLowerCase() === "resume";
        const ok = await setQueryActive(action[2], active);
        await reply(ok ? `${active ? "Resumed" : "Paused"} query ${action[2]}.` : `Query not found: ${action[2]}.`);
        continue;
      }
      if (/^(list|stats)$/i.test(content)) {
        commands++;
        const queries = await listQueries(true);
        const stats = /^stats$/i.test(content);
        await reply(
          queries.length
            ? queries
                .map((query) =>
                  stats
                    ? `#${query.id} ${query.active ? "ON" : "OFF"} · ${query.searchCount} searches · ${query.resultCount} tweets · ${query.alertCount} alerts\n${query.query}`
                    : `#${query.id} ${query.active ? "ON" : "OFF"} · ${query.query}`,
                )
                .join("\n")
            : "No Twitter queries. Add one with `add <advanced search query>`.",
        );
      }
    }
  }
  if (messages.length > 0) await setState(stateKey, messages.at(-1)!.id);
  return commands;
}
