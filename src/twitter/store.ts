import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type {
  TwitterDecision,
  TwitterExample,
  TwitterOrigin,
  TwitterQuery,
  TwitterRunMetrics,
  TwitterTweet,
} from "./types.js";

let client: SupabaseClient | null = null;

export interface TwitterDiscovery {
  tweet: TwitterTweet;
  queryId: number;
  attemptCount: number;
}

function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

function mapTweet(row: Record<string, unknown>): TwitterOrigin {
  const decision = row.decision as TwitterDecision | null;
  return {
    id: String(row.tweet_id),
    text: String(row.text),
    createdAt: String(row.tweet_created_at),
    url: String(row.url),
    author: { userName: String(row.author_handle) },
    viewCount: Number(row.view_count ?? 0),
    likeCount: Number(row.like_count ?? 0),
    retweetCount: Number(row.retweet_count ?? 0),
    replyCount: Number(row.reply_count ?? 0),
    sourceThread: Array.isArray(row.source_thread) ? (row.source_thread as TwitterTweet[]) : [],
    matchedQueryIds: Array.isArray(row.matched_query_ids) ? (row.matched_query_ids as number[]) : [],
    approximateVelocity: Number(row.approximate_velocity ?? 0),
    observedVelocity: row.observed_velocity == null ? null : Number(row.observed_velocity),
    status: String(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
    judgeAttemptCount: Number(row.judge_attempt_count ?? 0),
    writerAttemptCount: Number(row.writer_attempt_count ?? 0),
    decision,
    readyPost: (row.ready_post as string | null) ?? null,
  };
}

export async function assertTwitterSchema(): Promise<void> {
  const d = db();
  if (!d) throw new Error("Twitter-scannern kräver Supabase service_role.");
  const { error } = await d.from("twitter_queries").select("id").limit(1);
  if (error) throw new Error(`${error.message}. Kör senaste supabase/schema.sql.`);
}

export async function addQuery(query: string, addedBy: string): Promise<boolean> {
  const d = db();
  const clean = query.trim().replace(/\s+/g, " ").slice(0, 500);
  if (!d || !clean) return false;
  const { data: existing } = await d.from("twitter_queries").select("id").ilike("query", clean).maybeSingle();
  const result = existing
    ? await d.from("twitter_queries").update({ active: true, added_by: addedBy, updated_at: new Date().toISOString() }).eq("id", existing.id)
    : await d.from("twitter_queries").insert({ query: clean, added_by: addedBy });
  if (result.error) console.error("twitter query add:", result.error.message);
  return !result.error;
}

export async function setQueryActive(identifier: string, active: boolean): Promise<boolean> {
  const d = db();
  if (!d) return false;
  let query = d.from("twitter_queries").update({ active, updated_at: new Date().toISOString() });
  query = /^\d+$/.test(identifier) ? query.eq("id", Number(identifier)) : query.ilike("query", identifier.trim());
  const { data, error } = await query.select("id");
  if (error) console.error("twitter query active:", error.message);
  return !error && (data?.length ?? 0) > 0;
}

export async function listQueries(includeInactive = true): Promise<Array<TwitterQuery & { active: boolean; searchCount: number; resultCount: number; alertCount: number }>> {
  const d = db();
  if (!d) return [];
  let request = d.from("twitter_queries").select("id,query,active,search_count,result_count,alert_count").order("id");
  if (!includeInactive) request = request.eq("active", true);
  const { data, error } = await request;
  if (error) {
    console.error("twitter queries:", error.message);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: Number(row.id),
    query: String(row.query),
    active: Boolean(row.active),
    searchCount: Number(row.search_count),
    resultCount: Number(row.result_count),
    alertCount: Number(row.alert_count),
  }));
}

export async function claimQueries(limit: number): Promise<TwitterQuery[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.rpc("claim_twitter_queries", { p_limit: limit });
  if (error) throw new Error(`claim_twitter_queries: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => ({ id: Number(row.id), query: String(row.query) }));
}

export async function recordQueryResult(id: number, count: number, errorMessage?: string): Promise<void> {
  const d = db();
  if (!d) return;
  const { data } = await d.from("twitter_queries").select("result_count").eq("id", id).single();
  await d
    .from("twitter_queries")
    .update({
      result_count: Number(data?.result_count ?? 0) + count,
      last_error: errorMessage ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

export async function reserveDiscoveries(tweets: TwitterTweet[], queryId: number): Promise<number> {
  const d = db();
  if (!d || tweets.length === 0) return 0;
  const { data, error } = await d
    .from("twitter_discoveries")
    .upsert(
      tweets.map((tweet) => ({ tweet_id: tweet.id, query_id: queryId, tweet, status: "pending" })),
      { onConflict: "tweet_id", ignoreDuplicates: true },
    )
    .select("tweet_id");
  if (error) throw new Error(`twitter discoveries reserve: ${error.message}`);
  return data?.length ?? 0;
}

export async function claimDiscoveries(limit = 30): Promise<TwitterDiscovery[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.rpc("claim_twitter_discoveries", { p_limit: limit });
  if (error) throw new Error(`claim_twitter_discoveries: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    tweet: row.tweet as unknown as TwitterTweet,
    queryId: Number(row.query_id ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
  }));
}

export async function completeDiscovery(tweetId: string): Promise<void> {
  const d = db();
  if (!d) return;
  const { error } = await d
    .from("twitter_discoveries")
    .update({ status: "done", locked_at: null, last_error: null, processed_at: new Date().toISOString() })
    .eq("tweet_id", tweetId);
  if (error) throw new Error(`complete twitter discovery: ${error.message}`);
}

export async function failDiscovery(discovery: TwitterDiscovery, reason: string): Promise<void> {
  const d = db();
  if (!d) return;
  const delayMinutes = Math.min(360, 2 ** Math.min(discovery.attemptCount, 8));
  await d
    .from("twitter_discoveries")
    .update({
      status: "error",
      locked_at: null,
      last_error: reason.slice(0, 2000),
      next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
    })
    .eq("tweet_id", discovery.tweet.id);
}

export async function saveOrigins(
  origins: TwitterOrigin[],
  queryId: number,
): Promise<{ inserted: number; velocities: Map<string, number | null> }> {
  const d = db();
  if (!d || origins.length === 0) return { inserted: 0, velocities: new Map() };
  const ids = origins.map((origin) => origin.id);
  const [{ data: previousRows }, { data: existingRows }] = await Promise.all([
    d
    .from("twitter_observations")
    .select("tweet_id,observed_at,view_count")
    .in("tweet_id", ids)
    .order("observed_at", { ascending: false })
    .gte("observed_at", new Date(Date.now() - 24 * 3_600_000).toISOString()),
    d.from("twitter_origins").select("tweet_id,observed_velocity,matched_query_ids").in("tweet_id", ids),
  ]);
  const previous = new Map<string, { at: string; views: number }>();
  for (const row of previousRows ?? []) {
    const id = String(row.tweet_id);
    if (!previous.has(id)) previous.set(id, { at: String(row.observed_at), views: Number(row.view_count) });
  }
  const existing = new Map(
    (existingRows ?? []).map((row) => [
      String(row.tweet_id),
      {
        observed: row.observed_velocity == null ? null : Number(row.observed_velocity),
        queryIds: Array.isArray(row.matched_query_ids) ? (row.matched_query_ids as number[]) : [],
      },
    ]),
  );

  const insertRows = origins.map((origin) => ({
    tweet_id: origin.id,
    url: origin.url,
    text: origin.text,
    author_handle: origin.author.userName,
    tweet_created_at: origin.createdAt,
    source_thread: origin.sourceThread,
    matched_query_ids: [queryId],
    view_count: origin.viewCount,
    like_count: origin.likeCount,
    retweet_count: origin.retweetCount,
    reply_count: origin.replyCount,
    approximate_velocity: origin.approximateVelocity,
    status: "watching",
  }));
  const { data: inserted, error } = await d
    .from("twitter_origins")
    .upsert(insertRows, { onConflict: "tweet_id", ignoreDuplicates: true })
    .select("tweet_id");
  if (error) throw new Error(`twitter origins reserve: ${error.message}`);

  const now = new Date();
  const velocities = new Map<string, number | null>();
  for (const origin of origins) {
    const old = previous.get(origin.id);
    const hours = old ? (now.getTime() - Date.parse(old.at)) / 3_600_000 : 0;
    const observed =
      old && hours > 0.02
        ? Math.max(0, (origin.viewCount - old.views) / hours)
        : existing.get(origin.id)?.observed ?? null;
    velocities.set(origin.id, observed);
    await d
      .from("twitter_origins")
      .update({
        url: origin.url,
        text: origin.text,
        author_handle: origin.author.userName,
        source_thread: origin.sourceThread,
        view_count: origin.viewCount,
        like_count: origin.likeCount,
        retweet_count: origin.retweetCount,
        reply_count: origin.replyCount,
        approximate_velocity: origin.approximateVelocity,
        observed_velocity: observed,
        matched_query_ids: [...new Set([...(existing.get(origin.id)?.queryIds ?? []), ...(queryId > 0 ? [queryId] : [])])],
        updated_at: now.toISOString(),
      })
      .eq("tweet_id", origin.id);
  }
  await d.from("twitter_observations").insert(
    origins.map((origin) => ({
      tweet_id: origin.id,
      observed_at: now.toISOString(),
      view_count: origin.viewCount,
      like_count: origin.likeCount,
      retweet_count: origin.retweetCount,
      reply_count: origin.replyCount,
      views_per_hour: velocities.get(origin.id) ?? origin.approximateVelocity,
    })),
  );
  return { inserted: inserted?.length ?? 0, velocities };
}

export async function promoteEligible(tweetIds: string[]): Promise<void> {
  const d = db();
  if (!d || tweetIds.length === 0) return;
  await d
    .from("twitter_origins")
    .update({ status: "pending", next_attempt_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("tweet_id", tweetIds)
    .eq("status", "watching");
}

export async function getWatchingOrigins(limit = 100): Promise<TwitterOrigin[]> {
  const d = db();
  if (!d) return [];
  const cutoff = new Date(Date.now() - config.twitterMaxAgeHours * 3_600_000).toISOString();
  const { data, error } = await d
    .from("twitter_origins")
    .select("*")
    .eq("status", "watching")
    .gte("tweet_created_at", cutoff)
    .order("updated_at")
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => mapTweet(row as Record<string, unknown>));
}

export async function touchWatchingOrigins(tweetIds: string[]): Promise<void> {
  const d = db();
  if (!d || tweetIds.length === 0) return;
  await d
    .from("twitter_origins")
    .update({ updated_at: new Date().toISOString() })
    .in("tweet_id", tweetIds)
    .eq("status", "watching");
}

async function claimOrigins(rpc: string, limit: number): Promise<TwitterOrigin[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.rpc(rpc, { p_limit: limit });
  if (error) throw new Error(`${rpc}: ${error.message}`);
  return (data ?? []).map((row: Record<string, unknown>) => mapTweet(row));
}

export const claimForJudge = (limit: number) => claimOrigins("claim_twitter_judge", limit);
export const claimForWriter = (limit: number) => claimOrigins("claim_twitter_writer", limit);

export async function saveDecision(origin: TwitterOrigin, decision: TwitterDecision): Promise<void> {
  const d = db();
  if (!d) return;
  const { error } = await d
    .from("twitter_origins")
    .update({
      decision,
      status: decision.approved ? "approved" : "skipped",
      locked_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("tweet_id", origin.id);
  if (error) throw new Error(`save twitter decision: ${error.message}`);
}

export async function saveReadyPost(tweetId: string, readyPost: string): Promise<void> {
  const d = db();
  if (!d) return;
  const { error } = await d
    .from("twitter_origins")
    .update({ ready_post: readyPost, status: "approved", locked_at: null, last_error: null, updated_at: new Date().toISOString() })
    .eq("tweet_id", tweetId);
  if (error) throw new Error(`save ready post: ${error.message}`);
}

export async function failOrigin(origin: TwitterOrigin, stage: "judge" | "writer", reason: string): Promise<void> {
  const d = db();
  if (!d) return;
  const stageAttempts = stage === "judge" ? origin.judgeAttemptCount : origin.writerAttemptCount;
  const delayMinutes = Math.min(360, 2 ** Math.min(stageAttempts, 8));
  await d
    .from("twitter_origins")
    .update({
      status: "error",
      locked_at: null,
      last_error: `${stage}: ${reason}`.slice(0, 2000),
      next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("tweet_id", origin.id);
}

export async function getReadyAlerts(limit = 6): Promise<TwitterOrigin[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d
    .from("twitter_origins")
    .select("*")
    .eq("status", "approved")
    .not("ready_post", "is", null)
    .order("inserted_at")
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => mapTweet(row as Record<string, unknown>));
}

export async function markAlerted(origin: TwitterOrigin): Promise<void> {
  const d = db();
  if (!d) return;
  await d.from("twitter_origins").update({ status: "alerted", alerted_at: new Date().toISOString() }).eq("tweet_id", origin.id);
  for (const queryId of origin.matchedQueryIds) {
    const { data } = await d.from("twitter_queries").select("alert_count").eq("id", queryId).single();
    await d.from("twitter_queries").update({ alert_count: Number(data?.alert_count ?? 0) + 1 }).eq("id", queryId);
  }
}

export async function saveExample(input: Omit<TwitterExample, "id" | "createdAt"> & { fingerprint: string; sourceMessage: string }): Promise<{ id: number | null; duplicate: boolean; error: string | null }> {
  const d = db();
  if (!d) return { id: null, duplicate: false, error: "Supabase saknas" };
  const { data, error } = await d
    .from("twitter_examples")
    .upsert({
      fingerprint: input.fingerprint,
      origin_url: input.originUrl,
      origin_text: input.originText,
      coin_name: input.coinName,
      ticker: input.ticker,
      x_post: input.xPost,
      source_message: input.sourceMessage,
    }, { onConflict: "fingerprint", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) return { id: null, duplicate: false, error: error.message };
  if (data) return { id: Number(data.id), duplicate: false, error: null };
  const { data: existing } = await d.from("twitter_examples").select("id").eq("fingerprint", input.fingerprint).maybeSingle();
  return { id: existing ? Number(existing.id) : null, duplicate: true, error: null };
}

export async function getExamples(limit = 60): Promise<TwitterExample[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.from("twitter_examples").select("*").eq("active", true).order("created_at", { ascending: false }).limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => ({
    id: Number(row.id),
    originUrl: String(row.origin_url),
    originText: String(row.origin_text ?? ""),
    coinName: String(row.coin_name),
    ticker: String(row.ticker),
    xPost: String(row.x_post),
    createdAt: String(row.created_at),
  }));
}

export async function createRun(): Promise<number> {
  const d = db();
  if (!d) throw new Error("Supabase saknas");
  const { data, error } = await d.from("twitter_scan_runs").insert({}).select("id").single();
  if (error) throw new Error(error.message);
  return Number(data.id);
}

export async function checkpointRun(id: number, metrics: TwitterRunMetrics): Promise<void> {
  const d = db();
  if (!d) return;
  const { error } = await d
    .from("twitter_scan_runs")
    .update({
      queries_claimed: metrics.queriesClaimed,
      search_calls: metrics.searchCalls,
      lookup_calls: metrics.lookupCalls,
      empty_twitter_calls: metrics.emptyTwitterCalls,
      returned_tweets: metrics.returnedTweets,
      origins_saved: metrics.originsSaved,
      origins_judged: metrics.originsJudged,
      posts_written: metrics.postsWritten,
      alerts_sent: metrics.alertsSent,
      anthropic_input_tokens: metrics.usage.input,
      anthropic_output_tokens: metrics.usage.output,
      twitter_cost_usd: estimateTwitterCost(
        metrics.searchCalls + metrics.lookupCalls,
        metrics.returnedTweets,
        metrics.emptyTwitterCalls,
      ),
      claude_cost_usd: estimateClaudeCost(metrics.usage.input, metrics.usage.output),
    })
    .eq("id", id);
  if (error) throw new Error(`twitter run checkpoint: ${error.message}`);
}

export async function finishRun(id: number, metrics: TwitterRunMetrics, patch: { stopReason: string; error?: string | null; startedAt: number }): Promise<void> {
  const d = db();
  if (!d) return;
  const backlog = await getBacklog();
  await d.from("twitter_scan_runs").update({
    finished_at: new Date().toISOString(),
    queries_claimed: metrics.queriesClaimed,
    search_calls: metrics.searchCalls,
    lookup_calls: metrics.lookupCalls,
    empty_twitter_calls: metrics.emptyTwitterCalls,
    returned_tweets: metrics.returnedTweets,
    origins_saved: metrics.originsSaved,
    origins_judged: metrics.originsJudged,
    posts_written: metrics.postsWritten,
    alerts_sent: metrics.alertsSent,
    anthropic_input_tokens: metrics.usage.input,
    anthropic_output_tokens: metrics.usage.output,
    twitter_cost_usd: estimateTwitterCost(
      metrics.searchCalls + metrics.lookupCalls,
      metrics.returnedTweets,
      metrics.emptyTwitterCalls,
    ),
    claude_cost_usd: estimateClaudeCost(metrics.usage.input, metrics.usage.output),
    backlog: backlog.count,
    oldest_pending_minutes: backlog.oldestMinutes,
    run_duration_seconds: Math.round((Date.now() - patch.startedAt) / 1000),
    stop_reason: patch.stopReason,
    error: patch.error ?? null,
  }).eq("id", id);
}

export function estimateTwitterCost(calls: number, returnedTweets: number, emptyCalls = 0): number {
  return Math.max(calls, returnedTweets + emptyCalls) * 0.00015;
}

export function estimateClaudeCost(input: number, output: number): number {
  return (input / 1_000_000) * 3 + (output / 1_000_000) * 15;
}

export async function getMonthlyCosts(): Promise<{ twitter: number; claude: number }> {
  const d = db();
  if (!d) return { twitter: 0, claude: 0 };
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const { data } = await d.from("twitter_scan_runs").select("twitter_cost_usd,claude_cost_usd").gte("started_at", start);
  return (data ?? []).reduce((sum, row) => ({
    twitter: sum.twitter + Number(row.twitter_cost_usd ?? 0),
    claude: sum.claude + Number(row.claude_cost_usd ?? 0),
  }), { twitter: 0, claude: 0 });
}

export async function getBacklog(): Promise<{ count: number; oldestMinutes: number }> {
  const d = db();
  if (!d) return { count: 0, oldestMinutes: 0 };
  const { data } = await d.rpc("get_twitter_backlog_metrics");
  const row = data?.[0];
  return { count: Number(row?.backlog ?? 0), oldestMinutes: Number(row?.oldest_pending_minutes ?? 0) };
}

export async function claimRun(owner: string): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const { data, error } = await d.rpc("claim_twitter_run", {
    p_owner: owner,
    p_ttl_minutes: Math.ceil(config.twitterRunDeadlineMinutes + 3),
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function releaseRun(owner: string): Promise<void> {
  await db()?.rpc("release_twitter_run", { p_owner: owner });
}

export async function pruneObservations(): Promise<void> {
  await db()?.rpc("prune_twitter_observations", { p_keep_days: 30 });
}
