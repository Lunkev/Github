import { randomUUID } from "node:crypto";
import { config, hasKey } from "./config.js";
import { getState, setState } from "./db/githubStore.js";
import { sendTwitterAlert, sendTwitterDrift } from "./twitter/alert.js";
import { lookupTweets, searchTweets } from "./twitter/api.js";
import { ingestTwitterExamples, selectRelevantExamples } from "./twitter/examples.js";
import { classifyOriginEligibility, passesCheapFilter, rankOrigins } from "./twitter/filter.js";
import { ingestTwitterWatchlist } from "./twitter/ingest.js";
import { judgeOrigins } from "./twitter/judge.js";
import { resolveOrigin } from "./twitter/origin.js";
import {
  assertTwitterSchema,
  checkpointRun,
  claimDiscoveries,
  claimForJudge,
  claimForWriter,
  claimQueries,
  claimRun,
  completeDiscovery,
  createRun,
  estimateClaudeCost,
  estimateTwitterCost,
  expireOldOrigins,
  failDiscovery,
  failOrigin,
  finishRun,
  getBacklog,
  getExamples,
  getMonthlyCosts,
  getReadyAlerts,
  getWatchingOrigins,
  markAlerted,
  promoteEligible,
  pruneObservations,
  recordQueryResult,
  releaseRun,
  reserveDiscoveries,
  saveDecision,
  saveOrigins,
  saveReadyPost,
  touchWatchingOrigins,
} from "./twitter/store.js";
import type { TwitterOrigin, TwitterRunMetrics } from "./twitter/types.js";
import { approximateVelocity } from "./twitter/velocity.js";
import { writeReadyPost } from "./twitter/writer.js";

const SEARCH_CALL_RESERVE_USD = 20 * 0.00015;
const ORIGIN_RESOLVE_RESERVE_USD = 3 * 0.00015;
const WATCH_REFRESH_RESERVE_USD = 100 * 0.00015;
const JUDGE_CALL_RESERVE_USD = 0.10;
const WRITER_CALL_RESERVE_USD = 0.10;

function emptyMetrics(): TwitterRunMetrics {
  return {
    queriesClaimed: 0,
    searchCalls: 0,
    lookupCalls: 0,
    emptyTwitterCalls: 0,
    returnedTweets: 0,
    originsSaved: 0,
    originsWatching: 0,
    originsImmediate: 0,
    originsConfirmed: 0,
    originsExpired: 0,
    originsJudged: 0,
    postsWritten: 0,
    alertsSent: 0,
    usage: { input: 0, output: 0 },
  };
}

function runTwitterCost(metrics: TwitterRunMetrics): number {
  return estimateTwitterCost(
    metrics.searchCalls + metrics.lookupCalls,
    metrics.returnedTweets,
    metrics.emptyTwitterCalls,
  );
}

async function transitionAlert(key: string, active: boolean, activeMessage: string, recoveryMessage: string): Promise<void> {
  const previous = (await getState(key)) === "1";
  if (active !== previous) {
    await sendTwitterDrift(active ? activeMessage : recoveryMessage);
    await setState(key, active ? "1" : "0");
  }
}

function addUsage(metrics: TwitterRunMetrics, input: number, output: number): void {
  metrics.usage.input += input;
  metrics.usage.output += output;
}

async function main(): Promise<void> {
  const missing = [
    !hasKey.supabase() && "SUPABASE_URL/SUPABASE_SERVICE_KEY",
    !hasKey.twitter() && "TWITTERAPI_IO_KEY",
    !hasKey.anthropic() && "ANTHROPIC_API_KEY",
    !hasKey.discordBot() && "DISCORD_BOT_TOKEN",
    !hasKey.discordTwitter() && "DISCORD_WEBHOOK_TWITTER",
    !hasKey.discordTwitterDrift() && "DISCORD_WEBHOOK_TWITTER_DRIFT",
    !config.channelTwitterWatchlistId && "CHANNEL_TWITTER_WATCHLIST_ID",
    !config.channelTwitterExamplesId && "CHANNEL_TWITTER_EXAMPLES_ID",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Twitter Scanner saknar: ${missing.join(", ")}`);

  await assertTwitterSchema();
  const owner = randomUUID();
  if (!(await claimRun(owner))) {
    console.log("Twitter Scanner: en annan körning äger run-lock; avslutar.");
    return;
  }

  const startedAt = Date.now();
  const deadline = startedAt + config.twitterRunDeadlineMinutes * 60_000;
  const metrics = emptyMetrics();
  let runId: number | null = null;
  let stopReason = "complete";
  let apiErrors = 0;

  try {
    runId = await createRun();
    const [commands, examplesSaved] = await Promise.all([
      ingestTwitterWatchlist(),
      ingestTwitterExamples(),
    ]);
    console.log(`Twitter Scanner — ${new Date().toISOString()} · commands ${commands} · examples ${examplesSaved}`);

    const monthly = await getMonthlyCosts();
    let projectedTwitterCost = monthly.twitter;
    let projectedClaudeCost = monthly.claude;

    if (monthly.twitter < config.twitterMonthlyApiBudgetUsd) {
      const queries = await claimQueries(config.twitterQueriesPerRun);
      metrics.queriesClaimed = queries.length;
      for (const query of queries) {
        if (Date.now() >= deadline) {
          stopReason = "deadline";
          break;
        }
        if (projectedTwitterCost + SEARCH_CALL_RESERVE_USD > config.twitterMonthlyApiBudgetUsd) {
          stopReason = "twitter_budget";
          break;
        }
        const result = await searchTweets(query.query);
        metrics.searchCalls += result.calls;
        metrics.returnedTweets += result.returned;
        if (result.returned === 0) metrics.emptyTwitterCalls += result.calls;
        projectedTwitterCost = monthly.twitter + runTwitterCost(metrics);
        await recordQueryResult(query.id, result.returned, result.error ?? undefined);
        if (result.error) {
          apiErrors++;
          await checkpointRun(runId, metrics);
          continue;
        }

        await reserveDiscoveries(result.tweets.filter((tweet) => passesCheapFilter(tweet)), query.id);
        await checkpointRun(runId, metrics);
      }

      while (
        Date.now() < deadline &&
        projectedTwitterCost + ORIGIN_RESOLVE_RESERVE_USD <= config.twitterMonthlyApiBudgetUsd
      ) {
        const [discovery] = await claimDiscoveries(1);
        if (!discovery) break;
        const resolved = await resolveOrigin(discovery.tweet);
        metrics.lookupCalls += resolved.calls;
        metrics.returnedTweets += resolved.returned;
        metrics.emptyTwitterCalls += Math.max(0, resolved.calls - resolved.returned);
        apiErrors += resolved.errorCount;
        await checkpointRun(runId, metrics);
        projectedTwitterCost = monthly.twitter + runTwitterCost(metrics);
        if (!resolved.resolved) {
          await failDiscovery(discovery, "Origin kunde inte hämtas; retry köad.");
          continue;
        }
        resolved.origin.matchedQueryIds = [discovery.queryId];
        if (passesCheapFilter(resolved.origin)) {
          const saved = await saveOrigins([resolved.origin], discovery.queryId);
          metrics.originsSaved += saved.inserted;
          resolved.origin.observedVelocity = saved.velocities.get(resolved.origin.id) ?? null;
          const eligibility = classifyOriginEligibility(resolved.origin);
          if (eligibility === "immediate") {
            metrics.originsImmediate++;
            await promoteEligible([resolved.origin.id]);
          } else if (eligibility === "confirmed") {
            metrics.originsConfirmed++;
            await promoteEligible([resolved.origin.id]);
          } else if (eligibility === "watching") {
            metrics.originsWatching++;
          }
        }
        await completeDiscovery(discovery.tweet.id);
      }

      if (
        projectedTwitterCost + WATCH_REFRESH_RESERVE_USD <= config.twitterMonthlyApiBudgetUsd &&
        Date.now() < deadline
      ) {
        const watching = await getWatchingOrigins(100);
        if (watching.length) {
          const refreshed = await lookupTweets(watching.map((origin) => origin.id));
          metrics.lookupCalls += refreshed.calls;
          metrics.returnedTweets += refreshed.returned;
          if (refreshed.returned === 0) metrics.emptyTwitterCalls += refreshed.calls;
          if (refreshed.error) apiErrors++;
          await checkpointRun(runId, metrics);
          await touchWatchingOrigins(watching.map((origin) => origin.id));
          projectedTwitterCost = monthly.twitter + runTwitterCost(metrics);
          const previous = new Map(watching.map((origin) => [origin.id, origin]));
          const origins = refreshed.tweets.map((tweet): TwitterOrigin => {
            const old = previous.get(tweet.id)!;
            return {
              ...old,
              ...tweet,
              sourceThread: old.sourceThread,
              matchedQueryIds: old.matchedQueryIds,
              approximateVelocity: approximateVelocity(tweet),
              observedVelocity: null,
            };
          });
          const saved = await saveOrigins(origins, 0);
          const eligible: string[] = [];
          for (const origin of origins) {
            origin.observedVelocity = saved.velocities.get(origin.id) ?? null;
            const eligibility = classifyOriginEligibility(origin);
            if (eligibility === "confirmed") {
              metrics.originsConfirmed++;
              eligible.push(origin.id);
            } else if (eligibility === "immediate") {
              metrics.originsImmediate++;
              eligible.push(origin.id);
            } else if (eligibility === "watching") {
              metrics.originsWatching++;
            }
          }
          await promoteEligible(eligible);
        }
      }
    } else {
      stopReason = "twitter_budget";
    }

    metrics.originsExpired += await expireOldOrigins();
    projectedClaudeCost = monthly.claude + estimateClaudeCost(metrics.usage.input, metrics.usage.output);
    if (
      projectedClaudeCost + JUDGE_CALL_RESERVE_USD <= config.twitterMonthlyClaudeBudgetUsd &&
      Date.now() < deadline
    ) {
      const origins = rankOrigins(await claimForJudge(config.twitterMaxCandidatesPerRun));
      if (origins.length) {
        const judged = await judgeOrigins(origins);
        addUsage(metrics, judged.usage.input, judged.usage.output);
        await checkpointRun(runId, metrics);
        if (!judged.succeeded) {
          await Promise.all(origins.map((origin) => failOrigin(origin, "judge", judged.error ?? "unknown error")));
        } else {
          for (const origin of origins) {
            await saveDecision(origin, judged.decisions.get(origin.id)!);
            metrics.originsJudged++;
          }
        }
      }
    } else if (stopReason === "complete") {
      stopReason = Date.now() >= deadline ? "deadline" : "claude_budget";
    }

    metrics.originsExpired += await expireOldOrigins();
    const examples = await getExamples();
    while (
      Date.now() < deadline &&
      monthly.claude + estimateClaudeCost(metrics.usage.input, metrics.usage.output) <
        config.twitterMonthlyClaudeBudgetUsd - WRITER_CALL_RESERVE_USD
    ) {
      const [origin] = await claimForWriter(1);
      if (!origin) break;
      const written = await writeReadyPost(origin, selectRelevantExamples(origin, examples));
      addUsage(metrics, written.usage.input, written.usage.output);
      await checkpointRun(runId, metrics);
      if (!written.readyPost) {
        await failOrigin(origin, "writer", written.error ?? "unknown error");
        continue;
      }
      await saveReadyPost(origin.id, written.readyPost);
      metrics.postsWritten++;
    }

    metrics.originsExpired += await expireOldOrigins();
    for (const origin of await getReadyAlerts(6)) {
      if (!(await sendTwitterAlert(origin))) break;
      await markAlerted(origin);
      metrics.alertsSent++;
    }

    await pruneObservations();
    const backlog = await getBacklog();
    await transitionAlert(
      "twitter_api_errors",
      apiErrors >= 2,
      `${apiErrors} TwitterAPI.io-anrop misslyckades i samma körning.`,
      "TwitterAPI.io-anropen fungerar normalt igen.",
    );
    await transitionAlert(
      "twitter_budget_alert",
      stopReason === "twitter_budget" || projectedTwitterCost >= config.twitterMonthlyApiBudgetUsd,
      `TwitterAPI.io-budgeten är nådd: $${projectedTwitterCost.toFixed(2)} / $${config.twitterMonthlyApiBudgetUsd}.`,
      "TwitterAPI.io-budgeten är åter tillgänglig för en ny månad.",
    );
    await transitionAlert(
      "twitter_claude_budget_alert",
      stopReason === "claude_budget" ||
        monthly.claude + estimateClaudeCost(metrics.usage.input, metrics.usage.output) >=
          config.twitterMonthlyClaudeBudgetUsd,
      `Twitter Claude-budgeten är nådd: $${(monthly.claude + estimateClaudeCost(metrics.usage.input, metrics.usage.output)).toFixed(2)} / $${config.twitterMonthlyClaudeBudgetUsd}.`,
      "Twitter Claude-budgeten är åter tillgänglig för en ny månad.",
    );
    await transitionAlert(
      "twitter_queue_stalled",
      backlog.count > 0 && metrics.originsJudged + metrics.postsWritten === 0,
      `Ingen origin processades trots backlog ${backlog.count}.`,
      "Twitter-kön processar origins igen.",
    );
    await transitionAlert(
      "twitter_pending_late",
      backlog.oldestMinutes >= 120,
      `Äldsta Twitter-origin har väntat ${Math.round(backlog.oldestMinutes)} minuter.`,
      "Twitter-köns väntetid är åter under 120 minuter.",
    );

    await finishRun(runId, metrics, { stopReason, startedAt });
    console.log(
      `Klart: ${metrics.searchCalls} searches, ${metrics.returnedTweets} tweets, ` +
        `${metrics.originsImmediate} direct, ${metrics.originsConfirmed} confirmed, ` +
        `${metrics.originsWatching} watching, ${metrics.originsExpired} expired, ` +
        `${metrics.originsJudged} judged, ${metrics.alertsSent} alerts, backlog ${backlog.count}, ` +
        `X $${runTwitterCost(metrics).toFixed(4)}, ` +
        `Claude $${estimateClaudeCost(metrics.usage.input, metrics.usage.output).toFixed(4)}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stopReason = "error";
    if (runId !== null) await finishRun(runId, metrics, { stopReason, error: message, startedAt });
    await sendTwitterDrift(`Fatal: ${message}`);
    throw error;
  } finally {
    await releaseRun(owner);
  }
}

main().catch((error) => {
  console.error("Twitter Scanner fatal:", error);
  process.exit(1);
});
