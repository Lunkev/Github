import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatTwitterAlert } from "./alert.js";
import { buildAdvancedQuery, normalizeTweet } from "./api.js";
import { parseTwitterExample, selectRelevantExamples } from "./examples.js";
import { isEligibleOrigin } from "./filter.js";
import { advancedSearchFixture, multilingualTweets, tweetFixture } from "./fixtures.js";
import { resolveOrigin } from "./origin.js";
import { estimateClaudeCost, estimateTwitterCost } from "./store.js";
import type { TwitterExample, TwitterOrigin } from "./types.js";
import { approximateVelocity, effectiveVelocity } from "./velocity.js";

async function main(): Promise<void> {
  const parsed = advancedSearchFixture.tweets.map(normalizeTweet);
  assert.equal(parsed.filter(Boolean).length, 3);
  assert.ok(parsed.some((tweet) => tweet?.text.includes("動物園")));
  const query = buildAdvancedQuery("猫 OR dog min_faves:100", new Date("2026-08-30T12:00:00Z"));
  assert.match(query, /-filter:replies/);
  assert.match(query, /-filter:retweets/);
  assert.match(query, /since_time:\d+/);

  const q3 = tweetFixture("203");
  const q2 = tweetFixture("202", { quotedTweet: q3 });
  const q1 = tweetFixture("201", { quotedTweet: q2 });
  const start = tweetFixture("200", { quotedTweet: q1 });
  const resolved = await resolveOrigin(start);
  assert.equal(resolved.origin.id, "202");
  assert.equal(resolved.origin.sourceThread.length, 3);

  const child = tweetFixture("301", { inReplyToId: "300" });
  const parent = tweetFixture("300");
  const replyResolved = await resolveOrigin(child, async () => ({
    tweets: [parent],
    calls: 1,
    returned: 1,
    error: null,
  }));
  assert.equal(replyResolved.origin.id, "300");
  assert.equal(replyResolved.calls, 1);
  const unresolved = await resolveOrigin(
    tweetFixture("401", { text: "wow https://x.com/source/status/400" }),
    async () => ({ tweets: [], calls: 1, returned: 0, error: "temporary" }),
  );
  assert.equal(unresolved.resolved, false);

  const origin: TwitterOrigin = {
    ...multilingualTweets[0],
    sourceThread: [multilingualTweets[0]],
    matchedQueryIds: [1],
    approximateVelocity: approximateVelocity(multilingualTweets[0]),
    observedVelocity: 16_000,
    status: "pending",
    attemptCount: 0,
    judgeAttemptCount: 0,
    writerAttemptCount: 0,
  };
  assert.equal(effectiveVelocity(40_000, 16_000), 16_000);
  assert.equal(isEligibleOrigin(origin), true);

  const exampleContent = [
    "ORIGIN:",
    "https://x.com/example/status/101",
    "A lost cat returned home.",
    "NAME:",
    "THE RETURNED CAT",
    "TICKER:",
    "BACK",
    "POST:",
    "THIS IS THE RETURNED CAT",
    "",
    "it came back.",
  ].join("\n");
  const exampleParsed = parseTwitterExample(exampleContent);
  assert.ok(exampleParsed);
  assert.equal(exampleParsed.xPost, "THIS IS THE RETURNED CAT\n\nit came back.");
  const example: TwitterExample = {
    id: 1,
    ...exampleParsed,
    createdAt: "2026-01-01T00:00:00Z",
  };
  assert.equal(selectRelevantExamples(origin, [example], 1)[0].id, 1);

  origin.decision = {
    approved: true,
    score: 90,
    coinName: "THE RETURNED CAT",
    ticker: "BACK",
    narrative: "A lost cat returned home by itself.",
    category: "animal",
    reasoning: "Clear event.",
  };
  origin.readyPost = `THIS IS THE RETURNED CAT\n20,000 views · 0.5h old\n${origin.url}`;
  assert.equal(formatTwitterAlert(origin).trim().endsWith(origin.url), true);

  assert.ok(Math.abs(estimateTwitterCost(10, 0) - 0.0015) < 1e-10);
  assert.ok(Math.abs(estimateTwitterCost(1, 20) - 0.003) < 1e-10);
  assert.equal(estimateClaudeCost(1_000_000, 1_000_000), 18);

  const rotation = Array.from({ length: 9 }, (_, id) => ({ id, last: 0 }));
  const first = [...rotation].sort((a, b) => a.last - b.last || a.id - b.id).slice(0, 6);
  first.forEach((item) => { item.last = 1; });
  const second = [...rotation].sort((a, b) => a.last - b.last || a.id - b.id).slice(0, 6);
  assert.deepEqual(second.slice(0, 3).map((item) => item.id), [6, 7, 8]);

  const schema = await readFile(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(schema, /for update skip locked/i);
  assert.match(schema, /status = 'judging' and locked_at < now\(\) - interval '30 minutes'/i);
  assert.match(schema, /attempt_count >= 8/i);
  assert.match(schema, /judge_attempt_count >= 8/i);
  assert.match(schema, /writer_attempt_count >= 8/i);
  assert.match(schema, /create table if not exists twitter_discoveries/i);
  assert.match(schema, /create or replace function claim_twitter_discoveries/i);
  const apiSource = await readFile(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(apiSource, /queryType: "Top"/);
  const runtimeSource = await readFile(new URL("../twitterScan.ts", import.meta.url), "utf8");
  assert.match(runtimeSource, /reserveDiscoveries/);
  assert.match(runtimeSource, /checkpointRun/);
  const judgeSource = await readFile(new URL("./judge.ts", import.meta.url), "utf8");
  const writerSource = await readFile(new URL("./writer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(judgeSource, /selectRelevantExamples/);
  assert.match(writerSource, /TwitterExample/);

  console.log("twitter:selftest OK — API, flerspråkigt, origin, velocity, rotation, retry, judge/writer och alert.");
}

main().catch((error) => {
  console.error("twitter:selftest FAILED:", error);
  process.exit(1);
});
