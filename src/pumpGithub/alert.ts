import { config, hasKey } from "../config.js";
import { isDaytime } from "../github/alert.js";
import { postWebhook } from "../discord/webhook.js";
import type { GithubCoinRow } from "./store.js";

export function formatGithubCoinAlert(row: GithubCoinRow): string {
  const ticker = row.symbol.trim().startsWith("$") ? row.symbol.trim() : `$${row.symbol.trim()}`;
  const tweet = row.tweet_text?.trim();
  const parts = ["🚨 GITHUB COIN FOUND 🚨", "", `${row.name} - ${ticker}`, ""];
  if (tweet) {
    parts.push(tweet, "");
  }
  parts.push(row.github_url, "", `https://axiom.trade/meme/${row.mint}`);
  return parts.join("\n");
}

/** Dagtid: posta. Natt: true = köa. Tom webhook = logga. */
export async function sendGithubCoinAlert(row: GithubCoinRow): Promise<"sent" | "queued" | "logged"> {
  const text = formatGithubCoinAlert(row);
  if (!isDaytime()) return "queued";
  if (!hasKey.discordPumpGithub()) {
    console.log("\n" + text);
    return "logged";
  }
  await postWebhook(config.discordWebhookPumpGithub, text);
  return "sent";
}

export async function sendGithubCoinMorningBrief(rows: GithubCoinRow[]): Promise<void> {
  if (rows.length === 0 || !hasKey.discordPumpGithub()) return;
  const body = rows.map(formatGithubCoinAlert).join("\n\n———\n\n");
  await postWebhook(
    config.discordWebhookPumpGithub,
    `☀️ ${rows.length} GitHub-linked launch${rows.length === 1 ? "" : "es"} from last night:\n\n${body}`,
  );
}
