import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type { Finding } from "../github/judge.js";

// All state för GitHub-scannern. Utan Supabase körs allt i "statelöst läge":
// fallback-watchlist + diff-fönster = senaste 24h. Funkar för test, DB krävs för skarp drift.

let client: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

/** Fallback tills DB finns / watchlisten är tom. */
const FALLBACK_WATCHLIST = ["pump-fun"]; // org — expanderas till repo-förslag

export interface WatchEntry {
  target: string; // "org" eller "org/repo"
  deepScannedAt: string | null;
}

export async function getWatchlist(): Promise<WatchEntry[]> {
  const d = db();
  if (!d) return FALLBACK_WATCHLIST.map((t) => ({ target: t, deepScannedAt: null }));
  const { data } = await d.from("watch_repos").select("target, deep_scanned_at").eq("active", true);
  if (!data || data.length === 0)
    return FALLBACK_WATCHLIST.map((t) => ({ target: t, deepScannedAt: null }));
  return data.map((r) => ({ target: r.target, deepScannedAt: r.deep_scanned_at }));
}

export async function addWatchTarget(target: string, addedBy: string): Promise<void> {
  await db()?.from("watch_repos").upsert({ target, added_by: addedBy, active: true }, { onConflict: "target" });
}

export async function markDeepScanned(target: string): Promise<void> {
  await db()?.from("watch_repos").update({ deep_scanned_at: new Date().toISOString() }).eq("target", target);
}

/** Inlärda lexikon-termer (från #proven-generalisering). */
export async function getLearnedTerms(): Promise<string[]> {
  const d = db();
  if (!d) return [];
  const { data } = await d.from("lexicon").select("term");
  return (data ?? []).map((r) => r.term as string);
}

export async function addLearnedTerms(terms: string[], learnedFrom: string): Promise<void> {
  if (terms.length === 0) return;
  await db()
    ?.from("lexicon")
    .upsert(terms.map((term) => ({ term: term.toLowerCase(), learned_from: learnedFrom })), {
      onConflict: "term",
    });
}

/** Nyckel/värde-state: senaste körning, senaste Discord-meddelande-id per kanal, etc. */
export async function getState(key: string): Promise<string | null> {
  const d = db();
  if (!d) return null;
  const { data } = await d.from("scan_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  await db()?.from("scan_state").upsert({ key, value }, { onConflict: "key" });
}

/** Spara fynd; queued=true betyder nattfynd som väntar på morgonbriefen. */
export async function saveFindings(findings: Finding[], queued: Finding[]): Promise<void> {
  const d = db();
  if (!d || findings.length === 0) return;
  const queuedSet = new Set(queued);
  await d.from("findings").insert(
    findings.map((f) => ({
      repo: f.hit.repo,
      path: f.hit.path,
      line_number: f.hit.lineNumber,
      excerpt: f.hit.line,
      url: f.hit.url,
      egg_name: f.eggName,
      ticker_suggestion: f.tickerSuggestion,
      tweet_draft: f.tweetDraft,
      reasoning: f.reasoning,
      verdict: f.verdict,
      crowdedness_matches: f.crowdedness.matches,
      queued_for_morning: queuedSet.has(f),
    })),
  );
}

/** Hämta + rensa nattkön (körs av första körningen efter kl 07). */
export async function popQueuedFindings(): Promise<Finding[]> {
  const d = db();
  if (!d) return [];
  const { data } = await d.from("findings").select("*").eq("queued_for_morning", true);
  if (!data || data.length === 0) return [];
  await d.from("findings").update({ queued_for_morning: false }).eq("queued_for_morning", true);
  return data.map((r) => ({
    hit: {
      repo: r.repo,
      path: r.path,
      lineNumber: r.line_number,
      line: r.excerpt,
      url: r.url,
      term: "",
      mode: "diff" as const,
    },
    verdict: r.verdict,
    eggName: r.egg_name,
    tickerSuggestion: r.ticker_suggestion,
    tweetDraft: r.tweet_draft,
    reasoning: r.reasoning,
    crowdedness: { matches: r.crowdedness_matches ?? 0, topVolume24h: 0 },
  }));
}
