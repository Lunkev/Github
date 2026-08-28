import type { Signal } from "../types.js";

// DexScreener — gratis publikt API (rate-limited, ingen nyckel).
// Två jobb:
//  1. Signal: vilka tokens boostas/trendar just nu (= vad marknaden redan handlar)
//  2. Crowdedness-koll: finns det redan en coin på ett kandidat-narrativ?

const BASE = "https://api.dexscreener.com";

export async function fetchTrendingTokens(): Promise<Signal[]> {
  try {
    const res = await fetch(`${BASE}/token-boosts/top/v1`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      tokenAddress: string;
      chainId: string;
      description?: string;
      url?: string;
      totalAmount?: number;
    }[];
    return (Array.isArray(data) ? data : [])
      .filter((t) => t.chainId === "solana")
      .slice(0, 20)
      .map(
        (t): Signal => ({
          source: "dexscreener",
          title: `[boosted] ${t.description?.slice(0, 120) ?? t.tokenAddress}`,
          url: t.url,
          score: t.totalAmount,
          extra: { tokenAddress: t.tokenAddress },
        }),
      );
  } catch {
    return [];
  }
}

/** Sök efter befintliga coins på ett narrativ-keyword. Returnerar antal träffar med volym. */
export async function checkCrowdedness(keyword: string): Promise<{
  matches: number;
  topVolume24h: number;
}> {
  try {
    const res = await fetch(`${BASE}/latest/dex/search?q=${encodeURIComponent(keyword)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { matches: 0, topVolume24h: 0 };
    const data = (await res.json()) as {
      pairs?: { volume?: { h24?: number } }[];
    };
    const pairs = data.pairs ?? [];
    const topVolume24h = Math.max(0, ...pairs.map((p) => p.volume?.h24 ?? 0));
    return { matches: pairs.length, topVolume24h };
  } catch {
    return { matches: 0, topVolume24h: 0 };
  }
}
