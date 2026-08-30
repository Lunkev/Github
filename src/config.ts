import "dotenv/config";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPercentage(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5 && parsed <= 95 ? Math.round(parsed) : fallback;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  discordWebhookMaybe: process.env.DISCORD_WEBHOOK_MAYBE ?? "",
  discordWebhookPumpGithub: process.env.DISCORD_WEBHOOK_PUMP_GITHUB ?? "",
  discordWebhookNews: process.env.DISCORD_WEBHOOK_NEWS ?? "",
  discordWebhookTwitter: process.env.DISCORD_WEBHOOK_TWITTER ?? "",
  discordWebhookTwitterDrift: process.env.DISCORD_WEBHOOK_TWITTER_DRIFT ?? "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",
  channelProvenId: process.env.CHANNEL_PROVEN_ID ?? "",
  channelWatchlistId: process.env.CHANNEL_WATCHLIST_ID ?? "",
  channelNewsWatchlistId: process.env.CHANNEL_NEWS_WATCHLIST_ID ?? "",
  channelNewsExamplesId: process.env.CHANNEL_NEWS_EXAMPLES_ID ?? "",
  channelTwitterWatchlistId: process.env.CHANNEL_TWITTER_WATCHLIST_ID ?? "",
  channelTwitterExamplesId: process.env.CHANNEL_TWITTER_EXAMPLES_ID ?? "",
  // Lokalt: GITHUB_TOKEN i .env. I Actions: GITHUB_API_TOKEN (GITHUB_-prefix är reserverat för secrets där).
  githubToken: process.env.GITHUB_TOKEN ?? process.env.GITHUB_API_TOKEN ?? "",
  twitterApiIoKey: process.env.TWITTERAPI_IO_KEY ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY ?? "",
  apifyToken: process.env.APIFY_TOKEN ?? "",
  heliusApiKey: process.env.HELIUS_API_KEY ?? "",
  /** Matcha GitHub-länkar i description (av som default — bara website). */
  pumpMatchDescription: process.env.PUMP_MATCH_DESCRIPTION === "1",
  /** Komma-separerade metadata-hostar att skippa (mass-launchers). */
  pumpMetadataBlocklist: (process.env.PUMP_METADATA_BLOCKLIST ??
    "meta.uxento.io,metadata.j7tracker.io,m.rapidlaunch.io,ipfs.launchblitz.ai")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  /** Dagtidsfönster (svensk tid) för hot-alerts; utanför sparas fynden till morgonbriefen. */
  alertHours: { start: 7, end: 23, timezone: "Europe/Stockholm" },

  /** Hur många timmar bakåt en signal räknas som "färsk". */
  freshnessHours: 12,
  /** Max antal signaler som skickas in i Claude-scoringen. */
  maxSignalsToScore: 120,
  /** Score-tröskel för att en kandidat ska med i briefen. */
  briefThreshold: 60,
  /** Score-tröskel för intradag-alert (v2). */
  alertThreshold: 85,

  /** GitHub-scannerns AI-del får använda högst $65; ~$10 lämnas till Actions inom totalmålet $75. */
  githubClaudeMonthlyBudgetUsd: positiveNumber(process.env.GITHUB_CLAUDE_MONTHLY_BUDGET_USD, 65),
  githubMaxUnitsPerRun: Math.floor(positiveNumber(process.env.GITHUB_MAX_UNITS_PER_RUN, 20)),
  githubMaxCandidatesPerRun: Math.floor(positiveNumber(process.env.GITHUB_MAX_CANDIDATES_PER_RUN, 60)),
  githubRunDeadlineMinutes: positiveNumber(process.env.GITHUB_RUN_DEADLINE_MINUTES, 22),
  /** 5–95: båda lanes måste alltid få reserverad kapacitet. */
  githubFastLanePercent: boundedPercentage(process.env.GITHUB_FAST_LANE_PERCENT, 80),

  twitterQueriesPerRun: Math.min(6, Math.floor(positiveNumber(process.env.TWITTER_QUERIES_PER_RUN, 6))),
  twitterMaxCandidatesPerRun: Math.min(6, Math.floor(positiveNumber(process.env.TWITTER_MAX_CANDIDATES_PER_RUN, 6))),
  twitterMaxAgeHours: positiveNumber(process.env.TWITTER_MAX_AGE_HOURS, 12),
  twitterMinViews: Math.floor(positiveNumber(process.env.TWITTER_MIN_VIEWS, 8_000)),
  twitterMinViewsPerHour: positiveNumber(process.env.TWITTER_MIN_VIEWS_PER_HOUR, 15_000),
  twitterMonthlyApiBudgetUsd: positiveNumber(process.env.TWITTER_MONTHLY_API_BUDGET_USD, 40),
  twitterMonthlyClaudeBudgetUsd: positiveNumber(process.env.TWITTER_MONTHLY_CLAUDE_BUDGET_USD, 20),
  twitterClaudeModel: "claude-sonnet-4-6",
  twitterRunDeadlineMinutes: positiveNumber(process.env.TWITTER_RUN_DEADLINE_MINUTES, 12),
};

export const hasKey = {
  anthropic: () => config.anthropicApiKey.length > 0,
  discord: () => config.discordWebhookUrl.length > 0,
  discordPumpGithub: () => config.discordWebhookPumpGithub.length > 0,
  discordNews: () => config.discordWebhookNews.length > 0,
  discordTwitter: () => config.discordWebhookTwitter.length > 0,
  discordTwitterDrift: () => config.discordWebhookTwitterDrift.length > 0,
  discordBot: () => config.discordBotToken.length > 0,
  github: () => config.githubToken.length > 0,
  twitter: () => config.twitterApiIoKey.length > 0,
  supabase: () => config.supabaseUrl.length > 0 && config.supabaseServiceKey.length > 0,
  apify: () => config.apifyToken.length > 0,
};
