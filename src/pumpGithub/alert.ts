import { config, hasKey } from "../config.js";
import { isDaytime } from "../github/alert.js";
import { postWebhook } from "../discord/webhook.js";
import type { GithubCoinRow } from "./store.js";

export function formatGithubCoinAlert(row: GithubCoinRow): string {
  const stars = row.repo_stars == null ? "?" : `${row.repo_stars} stars`;
  const age = row.repo_age_days == null ? "?" : `repo ${row.repo_age_days}d old`;
  const lang = row.repo_language || (row.repo_missing ? "missing/private" : "—");
  const path = row.github_repo ? `${row.github_owner}/${row.github_repo}` : row.github_owner;
  return [
    `$${row.symbol} — ${row.name}`,
    `github.com/${path}  ·  ${stars}  ·  ${age}  ·  ${lang}`,
    `website: ${row.website}`,
    `https://pump.fun/${row.mint}`,
  ].join("\n");
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
