import type { Signal } from "../types.js";

// Hacker News — gratis, ingen nyckel. Fångar AI/tech-släpp tidigt.
// Vi använder Algolia-sök-API:t (officiellt, stabilt).
export async function fetchHackerNews(freshnessHours: number): Promise<Signal[]> {
  const since = Math.floor(Date.now() / 1000) - freshnessHours * 3600;
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&numericFilters=created_at_i>${since}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hits: { title: string; url?: string; points: number; objectID: string; created_at: string }[];
    };
    return data.hits.map(
      (h): Signal => ({
        source: "hackernews",
        title: h.title,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        score: h.points,
        publishedAt: h.created_at,
      }),
    );
  } catch {
    return [];
  }
}
