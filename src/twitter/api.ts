import { config, hasKey } from "../config.js";
import type { TwitterTweet } from "./types.js";

const BASE_URL = "https://api.twitterapi.io";

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function tweetIdFromUrl(url: string): string | null {
  return url.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i)?.[1] ?? null;
}

export function normalizeTweet(value: unknown): TwitterTweet | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const authorRow = (row.author ?? row.user ?? {}) as Record<string, unknown>;
  const id = string(row.id ?? row.tweet_id ?? row.tweetId);
  const userName = string(authorRow.userName ?? authorRow.username ?? row.userName ?? row.username);
  const text = string(row.text ?? row.full_text);
  const createdAt = string(row.createdAt ?? row.created_at);
  if (!id || !userName || !text || !createdAt) return null;
  const quotedRaw = row.quoted_tweet ?? row.quotedTweet;
  return {
    id,
    text,
    createdAt,
    url: string(row.url) || `https://x.com/${userName}/status/${id}`,
    author: { userName, name: string(authorRow.name) || undefined },
    viewCount: number(row.viewCount ?? row.view_count),
    likeCount: number(row.likeCount ?? row.like_count ?? row.favorite_count),
    retweetCount: number(row.retweetCount ?? row.retweet_count),
    replyCount: number(row.replyCount ?? row.reply_count),
    quotedTweet: quotedRaw ? normalizeTweet(quotedRaw) : null,
    inReplyToId:
      string(row.inReplyToId ?? row.in_reply_to_status_id ?? row.inReplyToStatusId) || null,
  };
}

function headers(): Record<string, string> {
  return { "x-api-key": config.twitterApiIoKey };
}

export interface TwitterFetchResult {
  tweets: TwitterTweet[];
  calls: number;
  returned: number;
  error: string | null;
}

export function buildAdvancedQuery(query: string, now = new Date()): string {
  const since = Math.floor((now.getTime() - config.twitterMaxAgeHours * 3_600_000) / 1000);
  return `${query.trim()} -filter:replies -filter:retweets since_time:${since}`;
}

export async function searchTweets(query: string): Promise<TwitterFetchResult> {
  if (!hasKey.twitter()) return { tweets: [], calls: 0, returned: 0, error: "TWITTERAPI_IO_KEY saknas" };
  const params = new URLSearchParams({ query: buildAdvancedQuery(query), queryType: "Top" });
  try {
    const response = await fetch(`${BASE_URL}/twitter/tweet/advanced_search?${params}`, {
      headers: headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return { tweets: [], calls: 1, returned: 0, error: `Twitter search ${response.status}` };
    }
    const body = (await response.json()) as { tweets?: unknown[] };
    const rawTweets = body.tweets ?? [];
    const tweets = rawTweets.map(normalizeTweet).filter((tweet): tweet is TwitterTweet => tweet !== null);
    return { tweets, calls: 1, returned: rawTweets.length, error: null };
  } catch (error) {
    return {
      tweets: [],
      calls: 1,
      returned: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function lookupTweets(ids: string[]): Promise<TwitterFetchResult> {
  if (!hasKey.twitter() || ids.length === 0) return { tweets: [], calls: 0, returned: 0, error: null };
  const unique = [...new Set(ids)].slice(0, 100);
  try {
    const params = new URLSearchParams({ tweet_ids: unique.join(",") });
    const response = await fetch(`${BASE_URL}/twitter/tweets?${params}`, {
      headers: headers(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { tweets: [], calls: 1, returned: 0, error: `Twitter lookup ${response.status}` };
    const body = (await response.json()) as { tweets?: unknown[] };
    const rawTweets = body.tweets ?? [];
    const tweets = rawTweets.map(normalizeTweet).filter((tweet): tweet is TwitterTweet => tweet !== null);
    return { tweets, calls: 1, returned: rawTweets.length, error: null };
  } catch (error) {
    return { tweets: [], calls: 1, returned: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchTweetsByIds(ids: string[]): Promise<TwitterTweet[]> {
  return (await lookupTweets(ids)).tweets;
}
