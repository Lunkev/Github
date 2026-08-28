import { config, hasKey } from "../config.js";
import type { Signal } from "../types.js";

// X/Twitter via twitterapi.io (pay-per-call — samma tjänst som i coin-agent).
// Två användningsområden:
//  1. Trender (vad trendar just nu)
//  2. KOL-bevakning: senaste posts från konton vars posts i sig kan vara narrativ
//
// TODO(Cursor): verifiera endpoints mot https://docs.twitterapi.io — payload-formatet
// nedan är en rimlig start men dubbelkolla fältnamn mot din nyckel.

const KOL_HANDLES = ["elonmusk"]; // fyll på: stora meme-konton, crypto-KOLs (~20 st)

export async function fetchTwitter(): Promise<Signal[]> {
  if (!hasKey.twitter()) return [];
  const headers = { "X-API-Key": config.twitterApiIoKey };
  const signals: Signal[] = [];

  // Trender (US)
  try {
    const res = await fetch("https://api.twitterapi.io/twitter/trends?woeid=23424977", {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { trends?: { name: string; tweet_count?: number }[] };
      for (const t of data.trends ?? []) {
        signals.push({ source: "twitter", title: `[trend] ${t.name}`, score: t.tweet_count });
      }
    }
  } catch {
    /* källfel får aldrig fälla hela skanningen */
  }

  // KOL-posts (senaste från varje konto)
  for (const handle of KOL_HANDLES) {
    try {
      const res = await fetch(
        `https://api.twitterapi.io/twitter/user/last_tweets?userName=${handle}`,
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        tweets?: { text: string; url?: string; createdAt?: string; likeCount?: number }[];
      };
      for (const tw of (data.tweets ?? []).slice(0, 5)) {
        signals.push({
          source: "twitter",
          title: `[@${handle}] ${tw.text.slice(0, 200)}`,
          url: tw.url,
          score: tw.likeCount,
          publishedAt: tw.createdAt,
        });
      }
    } catch {
      /* fortsätt */
    }
  }

  return signals;
}
