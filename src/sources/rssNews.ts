import Parser from "rss-parser";
import type { Signal } from "../types.js";

// Gratis nyhetskällor. Lägg till/ta bort flöden fritt — allt normaliseras till Signal.
const FEEDS: { url: string; label: string }[] = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", label: "BBC World" },
  { url: "https://techcrunch.com/feed/", label: "TechCrunch" },
  { url: "https://www.theverge.com/rss/index.xml", label: "The Verge" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", label: "CoinDesk" },
  { url: "https://decrypt.co/feed", label: "Decrypt" },
  { url: "https://arstechnica.com/ai/feed/", label: "Ars Technica AI" },
];

const parser = new Parser({ timeout: 10_000 });

export async function fetchRssNews(freshnessHours: number): Promise<Signal[]> {
  const cutoff = Date.now() - freshnessHours * 3600_000;
  const results = await Promise.allSettled(
    FEEDS.map(async (feed) => {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items ?? [])
        .filter((i) => {
          const t = i.isoDate ? Date.parse(i.isoDate) : NaN;
          return Number.isNaN(t) || t >= cutoff;
        })
        .slice(0, 15)
        .map(
          (i): Signal => ({
            source: "rss-news",
            title: `[${feed.label}] ${i.title ?? ""}`.trim(),
            url: i.link,
            publishedAt: i.isoDate,
          }),
        );
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
