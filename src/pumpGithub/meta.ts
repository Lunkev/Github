import { config } from "../config.js";
import { gatewayUrls, ipfsCid, isBlockedHost } from "./check.js";

/** Hämta off-chain metadata JSON. Aldrig throw. */
export async function fetchMetadata(uri: string): Promise<unknown | null> {
  if (!uri || isBlockedHost(uri)) return null;
  const cid = ipfsCid(uri);
  const urls = cid ? gatewayUrls(cid) : [uri];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "narrative-scanner" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const json: unknown = await res.json();
      return json;
    } catch {
      continue;
    }
  }
  return null;
}

/** Beskrivning bara om PUMP_MATCH_DESCRIPTION=1 (av som default). */
export function descriptionText(meta: unknown): string {
  if (!config.pumpMatchDescription) return "";
  if (!meta || typeof meta !== "object") return "";
  const d = (meta as Record<string, unknown>).description;
  return typeof d === "string" ? d : "";
}
