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
  return [
    header,
    "",
    `${f.eggName.slice(0, 200)} - ${ticker(f).slice(0, 50)}`,
    "",
    f.tweetDraft.trim().slice(0, 1000),
    "",
    f.hit.url.slice(0, 500),
  ].join("\n");
}

/** Postar fynd till rätt kanal. Returnerar de fynd som INTE postades (natt) för DB-kö. */
export async function sendAlerts(findings: Finding[], daytime = isDaytime()): Promise<Finding[]> {
  if (findings.length === 0) return [];
  if (!hasKey.discord()) {
    throw new Error("DISCORD_WEBHOOK_URL saknas; fynden lämnas okvitterade för retry.");
  }
  const queued: Finding[] = [];
  for (const f of findings) {
    if (f.verdict === "hot" && daytime) {
      if (!(await postWebhook(config.discordWebhookUrl, formatFinding(f, "hot")))) {
        throw new Error(`Discord kunde inte leverera hot-fyndet ${f.eggName}`);
      }
    } else if (f.verdict === "hot") {
      queued.push(f); // natt -> morgonbriefen
    } else {
      const url = config.discordWebhookMaybe || config.discordWebhookUrl;
      if (!(await postWebhook(url, formatFinding(f, "maybe")))) {
        throw new Error(`Discord kunde inte leverera maybe-fyndet ${f.eggName}`);
      }
    }
  }
  return queued;
}

/** Morgonbrief för köade nattfynd. */
export async function sendMorningBrief(
  queued: Finding[],
): Promise<{ sent: Finding[]; failed: Finding[] }> {
  if (queued.length === 0) return { sent: [], failed: [] };
  if (!hasKey.discord()) return { sent: [], failed: queued };
  const sent: Finding[] = [];
  const failed: Finding[] = [];
  // Ett fynd per webhook gör att Discord-gränsen aldrig trunkerar flera fynd,
  // och DB kan kvittera exakt de meddelanden som faktiskt levererades.
  for (let index = 0; index < queued.length; index++) {
    const body =
      `☀️ Night gem ${index + 1}/${queued.length} — still unlaunched:\n\n` +
      formatFinding(queued[index], "hot");
    if (await postWebhook(config.discordWebhookUrl, body)) sent.push(queued[index]);
    else failed.push(queued[index]);
  }
  return { sent, failed };
}

/** Drift har en egen kanal och får aldrig falla tillbaka till en fyndkanal. */
export async function sendOperationalAlert(message: string): Promise<void> {
  const body = `GITHUB SCANNER — DRIFTVARNING\n\n${message.slice(0, 1800)}`;
  if (!hasKey.discordGithubDrift()) {
    console.error(body);
    return;
  }
  await postWebhook(config.discordWebhookGithubDrift, body);
}
