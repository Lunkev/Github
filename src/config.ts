import "dotenv/config";

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  discordWebhookMaybe: process.env.DISCORD_WEBHOOK_MAYBE ?? "",
  discordWebhookPumpGithub: process.env.DISCORD_WEBHOOK_PUMP_GITHUB ?? "",
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",
  channelProvenId: process.env.CHANNEL_PROVEN_ID ?? "",
  channelWatchlistId: process.env.CHANNEL_WATCHLIST_ID ?? "",
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
};

export const hasKey = {
  anthropic: () => config.anthropicApiKey.length > 0,
  discord: () => config.discordWebhookUrl.length > 0,
  discordPumpGithub: () => config.discordWebhookPumpGithub.length > 0,
  discordBot: () => config.discordBotToken.length > 0,
  github: () => config.githubToken.length > 0,
  twitter: () => config.twitterApiIoKey.length > 0,
  supabase: () => config.supabaseUrl.length > 0 && config.supabaseServiceKey.length > 0,
  apify: () => config.apifyToken.length > 0,
};
