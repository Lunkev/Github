import { config } from "../config.js";
import type { TwitterOrigin, TwitterTweet } from "./types.js";
import { ageHours, effectiveVelocity } from "./velocity.js";

const REACTION = /^(omg|wow|wtf|lol|lmao|breaking|look at this|this is crazy|no way)[!.\s]*(https?:\/\/\S+)?$/i;
const PROMOTION = /\b(presale|airdrop|contract address|ca:|buy now|mint live|token launch|pump\.fun)\b/i;

export function passesCheapFilter(tweet: TwitterTweet, now = new Date()): boolean {
  if (ageHours(tweet, now) > config.twitterMaxAgeHours) return false;
  if (tweet.viewCount < config.twitterMinViews) return false;
  if (REACTION.test(tweet.text.trim())) return false;
  if (PROMOTION.test(tweet.text)) return false;
  return true;
}

export function isEligibleOrigin(origin: TwitterOrigin, now = new Date()): boolean {
  return (
    passesCheapFilter(origin, now) &&
    effectiveVelocity(origin.approximateVelocity, origin.observedVelocity) >= config.twitterMinViewsPerHour
  );
}

export function rankOrigins(origins: TwitterOrigin[]): TwitterOrigin[] {
  return [...origins].sort(
    (a, b) =>
      effectiveVelocity(b.approximateVelocity, b.observedVelocity) -
      effectiveVelocity(a.approximateVelocity, a.observedVelocity),
  );
}
