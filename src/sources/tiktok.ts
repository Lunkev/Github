import { hasKey } from "../config.js";
import type { Signal } from "../types.js";

// TikTok — svåraste källan (inget publikt API). Plan för v2:
//  Alternativ A (rekommenderad): Apify-actor för TikTok-trender, t.ex.
//    https://apify.com/clockworks/tiktok-trends-scraper — körs 1-2 ggr/dag, ~$5-15/mån.
//    Anropas via Apify REST API med APIFY_TOKEN.
//  Alternativ B (gratis men skörare): scrape TikTok Creative Center
//    (ads.tiktok.com/business/creativecenter) — trending hashtags/songs listas öppet.
//
// TODO(Cursor): implementera alternativ A när du skaffat Apify-token.
export async function fetchTikTok(): Promise<Signal[]> {
  if (!hasKey.apify()) return [];
  // TODO: POST https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items?token=...
  return [];
}
