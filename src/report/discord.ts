import { config, hasKey } from "../config.js";
import type { NarrativeCandidate } from "../types.js";

const CROWD_EMOJI = { none: "🟢", early: "🟡", crowded: "🔴" } as const;

export async function sendDiscordBrief(candidates: NarrativeCandidate[]): Promise<void> {
  if (!hasKey.discord()) {
    console.log("⚠️  Ingen DISCORD_WEBHOOK_URL — printar briefen i terminalen istället.\n");
    for (const c of candidates) console.log(formatCandidateText(c));
    return;
  }

  const top = candidates.filter((c) => c.score >= config.briefThreshold).slice(0, 10);
  const embed = {
    title: `🔍 Narrativ-brief — ${new Date().toISOString().slice(0, 10)}`,
    description:
      top.length === 0
        ? "Inga kandidater över tröskeln idag. Lugn dag = spara kulorna."
        : top.map(formatCandidateText).join("\n\n"),
    color: 0x5865f2,
    footer: { text: "narrative-scanner · inte finansiell rådgivning ens till dig själv" },
  };

  const res = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error(`Discord-webhook svarade ${res.status}`);
}

function formatCandidateText(c: NarrativeCandidate): string {
  return [
    `**${c.tickerSuggestion} — ${c.nameSuggestion}** · ${c.score}/100 ${CROWD_EMOJI[c.crowdedness]} · ${c.category}`,
    `${c.narrative}`,
    `*Vinkel:* ${c.angle}`,
    `*Varför nu:* ${c.whyNow}`,
    c.sources.length ? c.sources.map((s) => `<${s}>`).join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n");
}
