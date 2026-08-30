import type { TwitterTweet } from "./types.js";

export function ageHours(tweet: TwitterTweet, now = new Date()): number {
  return Math.max(1 / 60, (now.getTime() - Date.parse(tweet.createdAt)) / 3_600_000);
}

export function approximateVelocity(tweet: TwitterTweet, now = new Date()): number {
  return tweet.viewCount / ageHours(tweet, now);
}

export function effectiveVelocity(approximate: number, observed: number | null): number {
  return observed ?? approximate;
}
