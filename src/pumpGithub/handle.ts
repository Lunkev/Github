import { isDaytime } from "../github/alert.js";
import { extractTwitter, extractWebsite, parseGithubUrl, parseStatusUrl } from "./check.js";
import { fetchMetadata } from "./meta.js";
import { enrichGithub } from "./githubEnrich.js";
import { mintSeen, saveGithubCoin, type GithubCoinRow } from "./store.js";
import { sendGithubCoinAlert } from "./alert.js";
import { fetchTweetText } from "./tweet.js";

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  marketCap?: number | null;
}

export type HandleResult = "hit" | "skip" | "dup" | "error";

/** En token: metadata → website → github? → enrich → spara → alert. */
export async function handleNewToken(
  ev: NewTokenEvent,
  source: "live" | "backfill" = "live",
): Promise<HandleResult> {
  try {
    if (!ev.mint || !ev.uri) return "skip";
    if (await mintSeen(ev.mint)) return "dup";

    const meta = await fetchMetadata(ev.uri);
    if (!meta) return "skip";

    const website = extractWebsite(meta);
    if (!website) return "skip";

    const gh = parseGithubUrl(website);
    if (!gh) return "skip";

    const twitterRaw = extractTwitter(meta);
    const status = twitterRaw ? parseStatusUrl(twitterRaw) : null;
    const tweetText = status ? await fetchTweetText(status.id, status.url) : null;

    const enrich = await enrichGithub(gh.owner, gh.repo);
    const queued = !isDaytime();
    const row: GithubCoinRow = {
      mint: ev.mint,
      name: ev.name || "",
      symbol: ev.symbol || "",
      website,
      github_url: gh.url,
      github_owner: gh.owner,
      github_repo: gh.repo,
      repo_stars: enrich.stars,
      repo_created_at: enrich.createdAt,
      repo_age_days: enrich.ageDays,
      repo_language: enrich.language,
      market_cap: ev.marketCap ?? null,
      found_at: new Date().toISOString(),
      source,
      queued_for_morning: queued,
      repo_missing: enrich.missing,
      twitter_url: status?.url ?? twitterRaw,
      tweet_text: tweetText,
    };

    await saveGithubCoin(row);
    await sendGithubCoinAlert(row);
    console.log(`  HIT $${row.symbol} → ${gh.url}`);
    return "hit";
  } catch (e) {
    console.error("handleNewToken:", e instanceof Error ? e.message : e);
    return "error";
  }
}
