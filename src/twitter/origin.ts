import { lookupTweets, tweetIdFromUrl } from "./api.js";
import type { TwitterFetchResult, } from "./api.js";
import type { TwitterOrigin, TwitterTweet } from "./types.js";
import { approximateVelocity } from "./velocity.js";

type Lookup = (ids: string[]) => Promise<TwitterFetchResult>;

function linkedStatusId(tweet: TwitterTweet): string | null {
  const matches = tweet.text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\S+\/status\/\d+/gi) ?? [];
  for (const url of matches) {
    const id = tweetIdFromUrl(url);
    if (id && id !== tweet.id) return id;
  }
  return null;
}

export async function resolveOrigin(
  tweet: TwitterTweet,
  lookup: Lookup = lookupTweets,
): Promise<{ origin: TwitterOrigin; calls: number; returned: number; errorCount: number; resolved: boolean }> {
  const chain: TwitterTweet[] = [tweet];
  const seen = new Set([tweet.id]);
  let current = tweet;
  let calls = 0;
  let returned = 0;
  let errorCount = 0;
  let resolved = true;

  for (let hop = 0; hop < 2; hop++) {
    let next = current.quotedTweet ?? null;
    if (!next) {
      const linkedId = linkedStatusId(current);
      if (linkedId && !seen.has(linkedId)) {
        const result = await lookup([linkedId]);
        calls += result.calls;
        returned += result.returned;
        if (result.error) errorCount++;
        next = result.tweets[0] ?? null;
        if (!next) {
          resolved = false;
          break;
        }
      }
    }
    if (!next || seen.has(next.id)) break;
    chain.push(next);
    seen.add(next.id);
    current = next;
  }

  if (current.inReplyToId && !seen.has(current.inReplyToId)) {
    const result = await lookup([current.inReplyToId]);
    calls += result.calls;
    returned += result.returned;
    if (result.error) errorCount++;
    const parent = result.tweets[0];
    if (parent) {
      chain.push(parent);
      current = parent;
    } else {
      resolved = false;
    }
  }

  return {
    origin: {
      ...current,
      sourceThread: [...chain].reverse(),
      matchedQueryIds: [],
      approximateVelocity: approximateVelocity(current),
      observedVelocity: null,
      status: "watching",
      attemptCount: 0,
      judgeAttemptCount: 0,
      writerAttemptCount: 0,
    },
    calls,
    returned,
    errorCount,
    resolved,
  };
}
