import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type { Finding } from "../github/judge.js";
import type { RawHit } from "../github/scan.js";

// All state för GitHub-scannern. Utan Supabase körs allt i "statelöst läge":
// fallback-watchlist + diff-fönster = senaste 24h. Funkar för test, DB krävs för skarp drift.

let client: SupabaseClient | null = null;
let warnedKey = false;

function warnIfAnonKey(key: string): void {
  if (warnedKey) return;
  warnedKey = true;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      role?: string;
    };
    if (payload.role && payload.role !== "service_role") {
      console.error(
        `⚠️  SUPABASE_SERVICE_KEY har role="${payload.role}". Det är anon-nyckeln — RLS blockerar alla writes. Byt till service_role (Project Settings → API).`,
      );
    }
  } catch {
    /* nyckeln är inte en JWT — strunta i varningen */
  }
}

function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  warnIfAnonKey(config.supabaseServiceKey);
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

export async function addWatchTarget(target: string, addedBy: string): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const { error } = await d.from("watch_repos").upsert({ target, added_by: addedBy, active: true }, { onConflict: "target" });
  if (error) {
    console.error("watch_repos upsert:", error.message);
    return false;
  }
  return true;
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
  const d = db();
  if (!d) return;
  const { error } = await d.from("lexicon").upsert(
    terms.map((term) => ({ term: term.toLowerCase(), learned_from: learnedFrom })),
    { onConflict: "term" },
  );
  if (error) console.error("lexicon upsert:", error.message);
}

/** Nyckel/värde-state: senaste körning, senaste Discord-meddelande-id per kanal, etc. */
export async function getState(key: string): Promise<string | null> {
  const d = db();
  if (!d) return null;
  const { data } = await d.from("scan_state").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  const { error } = (await db()?.from("scan_state").upsert({ key, value }, { onConflict: "key" })) ?? {};
  if (error) console.error("scan_state upsert:", error.message);
}

export function findingFingerprint(repo: string, path: string, eggName: string): string {
  return `${repo}|${path}|${eggName.trim().toLowerCase()}`;
}

function hitKey(repo: string, path: string, line: string): string {
  return `${repo}|${path}|${line.toLowerCase().trim()}`;
}

/** Råträffar vars exakta rad redan finns som fynd — hoppa Claude. Ny rad i samma fil går vidare. */
export async function filterUnseenHits(hits: RawHit[]): Promise<RawHit[]> {
  const d = db();
  if (!d || hits.length === 0) return hits;
  const { data, error } = await d.from("findings").select("repo, path, excerpt");
  if (error) {
    console.error("filterUnseenHits:", error.message);
    return hits;
  }
  if (!data?.length) return hits;
  const seen = new Set(data.map((r) => hitKey(r.repo, r.path ?? "", r.excerpt ?? "")));
  return hits.filter((h) => !seen.has(hitKey(h.repo, h.path, h.line)));
}

/** Fynd som redan skickats (samma repo+path+egg) filtreras bort. */
export async function filterUnseenFindings(findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return [];
  const d = db();
  if (!d) return findings;
  const { data, error } = await d.from("findings").select("repo, path, egg_name, fingerprint");
  if (error) {
    console.error("filterUnseenFindings:", error.message);
    return findings;
  }
  if (!data?.length) return findings;
  const seen = new Set(
    data.map((r) => r.fingerprint || findingFingerprint(r.repo, r.path ?? "", r.egg_name ?? "")),
  );
  return findings.filter((f) => !seen.has(findingFingerprint(f.hit.repo, f.hit.path, f.eggName)));
}

/** Spara fynd (upsert på fingerprint). queued=true = nattfynd till morgonbriefen. */
export async function saveFindings(findings: Finding[], queued: Finding[]): Promise<void> {
  const d = db();
  if (!d || findings.length === 0) return;
  const queuedSet = new Set(queued);
  const { error } = await d.from("findings").upsert(
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
      fingerprint: findingFingerprint(f.hit.repo, f.hit.path, f.eggName),
    })),
    { onConflict: "fingerprint", ignoreDuplicates: true },
  );
  if (error) console.error("findings upsert:", error.message);
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
