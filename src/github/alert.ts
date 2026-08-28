import { config, hasKey } from "../config.js";
import { postWebhook } from "../discord/webhook.js";
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

function ticker(f: Finding): string {
  const t = f.tickerSuggestion.trim();
  return t.startsWith("$") ? t : `$${t}`;
}

function formatFinding(f: Finding, kind: "hot" | "maybe"): string {
  const header = kind === "hot" ? "🚨 GEM FOUND 🚨" : "👀 GEM MAYBE 👀";
  return [header, "", `${f.eggName} - ${ticker(f)}`, "", f.tweetDraft.trim(), "", f.hit.url].join("\n");
}

/** Postar fynd till rätt kanal. Returnerar de fynd som INTE postades (natt) för DB-kö. */
export async function sendAlerts(findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return [];
  if (!hasKey.discord()) {
    for (const f of findings) console.log("\n" + formatFinding(f, f.verdict));
    return [];
  }
  const daytime = isDaytime();
  const queued: Finding[] = [];
  for (const f of findings) {
    if (f.verdict === "hot" && daytime) {
      await postWebhook(config.discordWebhookUrl, formatFinding(f, "hot"));
    } else if (f.verdict === "hot") {
      queued.push(f); // natt -> morgonbriefen
    } else {
      const url = config.discordWebhookMaybe || config.discordWebhookUrl;
      await postWebhook(url, formatFinding(f, "maybe"));
    }
  }
  return queued;
}

/** Morgonbrief för köade nattfynd. */
export async function sendMorningBrief(queued: Finding[]): Promise<void> {
  if (queued.length === 0 || !hasKey.discord()) return;
  const body = queued.map((f) => formatFinding(f, "hot")).join("\n\n———\n\n");
  await postWebhook(
    config.discordWebhookUrl,
    `☀️ ${queued.length} gem${queued.length === 1 ? "" : "s"} from last night — still unlaunched:\n\n${body}`,
  );
}
