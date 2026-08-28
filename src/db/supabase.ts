import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type { NarrativeCandidate, Signal } from "../types.js";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

export async function saveScan(signals: Signal[], candidates: NarrativeCandidate[]): Promise<void> {
  const db = getClient();
  if (!db) {
    console.log("⚠️  Ingen Supabase-konfig — skippar DB-spar.");
    return;
  }
  const ranAt = new Date().toISOString();

  const { error: sigErr } = await db
    .from("signals")
    .insert(signals.map((s) => ({ ran_at: ranAt, ...s, extra: s.extra ?? {} })));
  if (sigErr) console.error("signals insert:", sigErr.message);

  const { error: narErr } = await db.from("narratives").insert(
    candidates.map((c) => ({
      ran_at: ranAt,
      narrative: c.narrative,
      ticker_suggestion: c.tickerSuggestion,
      name_suggestion: c.nameSuggestion,
      angle: c.angle,
      why_now: c.whyNow,
      score: c.score,
      crowdedness: c.crowdedness,
      sources: c.sources,
      category: c.category,
    })),
  );
  if (narErr) console.error("narratives insert:", narErr.message);
}

/**
 * Hämtar en textsammanfattning av bevisade mönster ur proven_coins.
 * Matas in i Claude-prompten så scoringen blir smartare över tid.
 */
export async function getProvenPatterns(): Promise<string> {
  const db = getClient();
  if (!db) return "";
  const { data, error } = await db
    .from("proven_coins")
    .select("ticker, narrative, category, peak_mcap_usd, notes")
    .order("peak_mcap_usd", { ascending: false })
    .limit(30);
  if (error || !data) return "";
  return data
    .map(
      (c) =>
        `- ${c.ticker} (${c.category}): "${c.narrative}" → peak ~$${Math.round((c.peak_mcap_usd ?? 0) / 1000)}k${c.notes ? ` — ${c.notes}` : ""}`,
    )
    .join("\n");
}
