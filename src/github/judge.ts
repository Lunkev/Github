import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import { checkCrowdedness } from "../provenCoins/dexscreener.js";
import type { RawHit } from "./scan.js";

// Steg 2: Claude bedömer råträffarna. Bara träffar (inte hela repos) skickas in -> billigt.

const FindingSchema = z.object({
  hitIndex: z.number(),
  verdict: z.enum(["hot", "maybe", "skip"]),
  eggName: z.string(), // det faktiska fyndet, t.ex. "My Coin"
  tickerSuggestion: z.string(),
  tweetDraft: z.string(),
  reasoning: z.string(),
});
const ResponseSchema = z.object({ findings: z.array(FindingSchema) });

export interface Finding {
  hit: RawHit;
  verdict: "hot" | "maybe";
  eggName: string;
  tickerSuggestion: string;
  tweetDraft: string;
  reasoning: string;
  crowdedness: { matches: number; topVolume24h: number };
}

export async function judgeHits(hits: RawHit[], provenPatterns: string): Promise<Finding[]> {
  if (hits.length === 0) return [];
  if (!hasKey.anthropic()) {
    console.log(`⚠️  Ingen ANTHROPIC_API_KEY — ${hits.length} råträffar kan inte bedömas.`);
    return [];
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const hitText = hits
    .slice(0, 80)
    .map((h, i) => `[${i}] ${h.repo} · ${h.path}:${h.lineNumber} (${h.mode}) — "${h.line}"`)
    .join("\n");

  const prompt = `Du hjälper en Solana-memecoin-deployer hitta "easter eggs" i GitHub-repos — launchbara namn/strängar gömda i officiella repos. Guldstandard-exemplet: strängen "my coin" i pump.funs officiella repo launchades som $MYC med narrativet "soft-shilled in their official repo".

Nedan är råträffar från lexikonfiltret. De flesta är brus (ordet "coin" i API-dokumentation etc). Ditt jobb: hitta de få som är RIKTIGA fynd — namngivna saker (exempel-coins, placeholder-namn, maskotar, roliga strängar) som går att launcha med "hidden in the official repo"-narrativ.

Bedömning:
- "hot": tydligt namngivet, roligt/absurt, i ett repo med clout — launchbart idag.
- "maybe": intressant men osäkert — värt en mänsklig titt.
- "skip": brus. (Skickas inte vidare — var hård här.)

Bevisade mönster från vår databas:
${provenPatterns || "(tomt än)"}

RÅTRÄFFAR:
${hitText}

För hot/maybe: skriv tweetDraft i denna stil: "Yo guys just found this crazy easter egg hidden in the official @X github repo. <namn> ($<TICKER>), soft shilled by <företag> in their own repo and we never ran it yet???"

Svara ENDAST med JSON: {"findings":[{"hitIndex":0,"verdict":"hot|maybe|skip","eggName":"...","tickerSuggestion":"$...","tweetDraft":"...","reasoning":"..."}]}
Ta bara med hot och maybe i svaret.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed;
  try {
    parsed = ResponseSchema.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
  } catch (e) {
    console.error("Kunde inte parsa judge-svar:", e);
    return [];
  }

  // Olaunchad-koll mot DexScreener — bara på det som passerat Claude.
  const findings: Finding[] = [];
  for (const f of parsed.findings) {
    const hit = hits[f.hitIndex];
    if (!hit || f.verdict === "skip") continue;
    const crowdedness = await checkCrowdedness(f.eggName);
    // Redan launchad med rejäl volym -> tyst (rött ljus).
    if (crowdedness.topVolume24h > 100_000) continue;
    findings.push({
      hit,
      verdict: f.verdict,
      eggName: f.eggName,
      tickerSuggestion: f.tickerSuggestion,
      tweetDraft: f.tweetDraft,
      reasoning: f.reasoning,
      crowdedness,
    });
  }
  return findings;
}
