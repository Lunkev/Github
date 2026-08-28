import type { Signal } from "../types.js";

// Reddits publika JSON-endpoints — gratis, ingen nyckel (var snäll med rate limits).
// r/OutOfTheLoop är guld: folk frågar "varför trendar X?" exakt när något bryter ut.
const SUBREDDITS = ["all", "OutOfTheLoop", "memes", "CryptoCurrency"];

export async function fetchReddit(): Promise<Signal[]> {
  const results = await Promise.allSettled(
    SUBREDDITS.map(async (sub) => {
      const url = `https://www.reddit.com/r/${sub}/rising.json?limit=15`;
      const res = await fetch(url, {
        headers: { "User-Agent": "narrative-scanner/0.1 (personal research tool)" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [] as Signal[];
      const data = (await res.json()) as {
        data: { children: { data: { title: string; permalink: string; ups: number; created_utc: number } }[] };
      };
      return data.data.children.map(
        (c): Signal => ({
          source: "reddit",
          title: `[r/${sub}] ${c.data.title}`,
          url: `https://reddit.com${c.data.permalink}`,
          score: c.data.ups,
          publishedAt: new Date(c.data.created_utc * 1000).toISOString(),
        }),
      );
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
