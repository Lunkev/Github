import { config, hasKey } from "../config.js";
import type { Finding } from "./judge.js";

// Discord-alerts: hot -> #gems-hot direkt (dagtid), maybe -> #gems-maybe.
// Nattfynd postas inte direkt — de sparas i DB och morgonkörningen (första efter 07) tar dem.

export function isDaytime(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("sv-SE", {
      hour: "numeric",
      hour12: false,
      timeZone: config.alertHours.timezone,
    }).format(now),
  );
  return hour >= config.alertHours.start && hour < config.alertHours.end;
}

function formatFinding(f: Finding): string {
  const crowd =
    f.crowdedness.matches === 0
      ? "🟢 OLAUNCHAD"
      : `🟡 ${f.crowdedness.matches} träffar, topp-volym $${Math.round(f.crowdedness.topVolume24h / 1000)}k`;
  return [
    `**${f.eggName} → ${f.tickerSuggestion}** · ${crowd}`,
    `📍 \`${f.hit.repo}\` · ${f.hit.path}:${f.hit.lineNumber}`,
    `> ${f.hit.line}`,
    `🔗 ${f.hit.url}`,
    `💡 ${f.reasoning}`,
    `📝 Tweet-utkast:\n\`\`\`\n${f.tweetDraft}\n\`\`\``,
  ].join("\n");
}

async function postWebhook(url: string, content: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1990) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error(`Discord-webhook svarade ${res.status}`);
}

/** Postar fynd till rätt kanal. Returnerar de fynd som INTE postades (natt) för DB-kö. */
export async function sendAlerts(findings: Finding[]): Promise<Finding[]> {
  if (!hasKey.discord()) {
    for (const f of findings) console.log("\n" + formatFinding(f));
    return [];
  }
  const daytime = isDaytime();
  const queued: Finding[] = [];
  for (const f of findings) {
    if (f.verdict === "hot" && daytime) {
      await postWebhook(config.discordWebhookUrl, `🚨 **GEM HITTAD**\n${formatFinding(f)}`);
    } else if (f.verdict === "hot") {
      queued.push(f); // natt -> morgonbriefen
    } else {
      const url = config.discordWebhookMaybe || config.discordWebhookUrl;
      await postWebhook(url, `🤔 Maybe:\n${formatFinding(f)}`);
    }
  }
  return queued;
}

/** Morgonbrief för köade nattfynd. */
export async function sendMorningBrief(queued: Finding[]): Promise<void> {
  if (queued.length === 0 || !hasKey.discord()) return;
  const body = queued.map(formatFinding).join("\n\n———\n\n");
  await postWebhook(
    config.discordWebhookUrl,
    `☀️ **Morgonbrief — ${queued.length} fynd från i natt (ingen har launchat dem än):**\n\n${body}`,
  );
}
