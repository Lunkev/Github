import Parser from "rss-parser";
import type { Signal } from "../types.js";

// Google Trends "Trending Now" via RSS — gratis, ingen nyckel.
// approx_traffic ger en grov velocity-siffra.
const TRENDS_RSS = "https://trends.google.com/trending/rss?geo=US";

const parser = new Parser({
  timeout: 10_000,
  customFields: { item: [["ht:approx_traffic", "approxTraffic"]] },
});

export async function fetchGoogleTrends(): Promise<Signal[]> {
  try {
    const parsed = await parser.parseURL(TRENDS_RSS);
    return (parsed.items ?? []).slice(0, 25).map((i): Signal => {
      const traffic = String((i as unknown as Record<string, unknown>).approxTraffic ?? "");
      const score = parseInt(traffic.replace(/[^0-9]/g, ""), 10) || undefined;
      return {
        source: "google-trends",
        title: i.title ?? "",
        url: i.link,
        score,
        publishedAt: i.isoDate,
        extra: { approxTraffic: traffic },
      };
    });
  } catch {
    return [];
  }
}
