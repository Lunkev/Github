import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import {
  addWatchTarget,
  addLearnedTerms,
  getState,
  setState,
} from "../db/githubStore.js";
import { createClient } from "@supabase/supabase-js";

// Läser #watchlist och #proven via Discords REST-API (bot-token, ingen live-bot behövs).
// Körs i början av varje skanning: nya meddelanden -> databasen.

interface DiscordMessage {
  id: string;
  content: string;
  author: { bot?: boolean; username: string };
}

async function fetchNewMessages(channelId: string, afterId: string | null): Promise<DiscordMessage[]> {
  if (!hasKey.discordBot() || !channelId) return [];
  const after = afterId ? `&after=${afterId}` : "";
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=50${after}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return [];
    const msgs = (await res.json()) as DiscordMessage[];
    return msgs.filter((m) => !m.author.bot).reverse(); // äldst först
  } catch {
    return [];
  }
}

/** #watchlist: rader som "add pump-fun" eller "add org/repo". Enkel parsning, ingen AI behövs. */
export async function ingestWatchlist(): Promise<string[]> {
  const stateKey = `last_msg_${config.channelWatchlistId}`;
  const msgs = await fetchNewMessages(config.channelWatchlistId, await getState(stateKey));
  const added: string[] = [];
  for (const m of msgs) {
    const match = m.content.trim().match(/^add\s+([\w.-]+(?:\/[\w.-]+)?)/i);
    if (match) {
      if (await addWatchTarget(match[1], m.author.username)) added.push(match[1]);
    }
  }
  if (msgs.length > 0) await setState(stateKey, msgs[msgs.length - 1].id);
  return added;
}

const ProvenSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  narrative: z.string(),
  category: z.string(),
  copy_style: z.string(),
  github_link: z.string().nullable(),
  tweet_text: z.string().optional().default(""),
  new_lexicon_terms: z.array(z.string()),
  notes: z.string(),
});

/** #proven: fritext från Kevin -> Claude strukturerar -> proven_coins + nya lexikon-termer. */
export async function ingestProven(): Promise<number> {
  if (!hasKey.anthropic()) return 0;
  const stateKey = `last_msg_${config.channelProvenId}`;
  const msgs = await fetchNewMessages(config.channelProvenId, await getState(stateKey));
  if (msgs.length === 0) return 0;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  let count = 0;
  for (const m of msgs) {
    if (m.content.trim().length < 10) continue;
    const msg = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: `En memecoin-deployer skickar in en BEVISAD launch till sitt mönsterbibliotek. Strukturera den.

Viktigast:
1. "tweet_text" — det EXAKTA X-inlägget från inskicket, verbatim, radbrytningar bevarade. Parafrasera INTE. Om flera stycken ser ut som tweeten: ta hela tweet-blocket. Finns ingen tweet: tom sträng "".
2. "new_lexicon_terms" — 2-6 nya GENERELLA söktermer att leta efter i GitHub-repos (t.ex. lärde $MYC oss "my coin" och "example metadata").

Inskick:
"""${m.content.slice(0, 3000)}"""

Svara ENDAST med JSON:
{"ticker":"$...","name":"...","narrative":"...","category":"...","copy_style":"...","github_link":null,"tweet_text":"...","new_lexicon_terms":["..."],"notes":"..."}`,
        },
      ],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      const parsed = ProvenSchema.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
      if (hasKey.supabase()) {
        const db = createClient(config.supabaseUrl, config.supabaseServiceKey);
        const { error } = await db.from("proven_coins").insert({
          ticker: parsed.ticker,
          name: parsed.name,
          narrative: parsed.narrative,
          category: parsed.category,
          source_platform: parsed.github_link ? "github" : null,
          notes: parsed.notes,
          source_message: m.content.slice(0, 4000),
          tweet_text: parsed.tweet_text.trim() || m.content.slice(0, 4000),
        });
        if (error) console.error("proven_coins insert:", error.message);
      }
      await addLearnedTerms(parsed.new_lexicon_terms, parsed.ticker);
      count++;
    } catch {
      console.error("Kunde inte strukturera #proven-inskick:", m.content.slice(0, 80));
    }
  }
  await setState(stateKey, msgs[msgs.length - 1].id);
  return count;
}
