import { config, hasKey } from "../config.js";
import { postWebhook } from "../discord/webhook.js";
import type { TwitterOrigin } from "./types.js";
import { ageHours, effectiveVelocity } from "./velocity.js";

export function formatTwitterAlert(origin: TwitterOrigin): string {
  const decision = origin.decision;
  if (!decision || !origin.readyPost) throw new Error("Twitter-alert saknar decision/readyPost");
  const safePost = origin.readyPost.replace(/```/g, "'''").slice(0, 1_050);
  return [
    `Deployable — ${decision.coinName} ($${decision.ticker})`,
    "",
    `${origin.viewCount.toLocaleString("en-US")} views · ${ageHours(origin).toFixed(1)}h ago · @${origin.author.userName}`,
    `${Math.round(effectiveVelocity(origin.approximateVelocity, origin.observedVelocity)).toLocaleString("en-US")} views/hour`,
    "",
    decision.narrative,
    "",
    "READY TO POST",
    "```",
    safePost,
    "```",
    "",
    origin.url,
  ].join("\n");
}

export async function sendTwitterAlert(origin: TwitterOrigin): Promise<boolean> {
  if (!hasKey.discordTwitter()) return false;
  if (ageHours(origin) > config.twitterMaxAgeHours) return false;
  return postWebhook(config.discordWebhookTwitter, formatTwitterAlert(origin));
}

export async function sendTwitterDrift(message: string): Promise<boolean> {
  if (!hasKey.discordTwitterDrift()) {
    console.error(`TWITTER SCANNER — DRIFTVARNING\n${message}`);
    return false;
  }
  return postWebhook(config.discordWebhookTwitterDrift, `TWITTER SCANNER — DRIFTVARNING\n\n${message}`);
}
