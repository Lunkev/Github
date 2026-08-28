import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";

let client: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

export interface GithubCoinRow {
  mint: string;
  name: string;
  symbol: string;
  website: string;
  github_url: string;
  github_owner: string;
  github_repo: string | null;
  repo_stars: number | null;
  repo_created_at: string | null;
  repo_age_days: number | null;
  repo_language: string | null;
  market_cap: number | null;
  found_at: string;
  source: "live" | "backfill";
  queued_for_morning: boolean;
  repo_missing: boolean;
}

export async function mintSeen(mint: string): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const { data } = await d.from("github_coins").select("mint").eq("mint", mint).maybeSingle();
  return !!data;
}

export async function saveGithubCoin(row: GithubCoinRow): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const { error } = await d.from("github_coins").upsert(row, { onConflict: "mint", ignoreDuplicates: true });
  if (error) {
    console.error("github_coins upsert:", error.message);
    return false;
  }
  return true;
}

export async function popQueuedGithubCoins(): Promise<GithubCoinRow[]> {
  const d = db();
  if (!d) return [];
  const { data } = await d.from("github_coins").select("*").eq("queued_for_morning", true);
  if (!data?.length) return [];
  await d.from("github_coins").update({ queued_for_morning: false }).eq("queued_for_morning", true);
  return data as GithubCoinRow[];
}
