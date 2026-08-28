import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasKey } from "../config.js";
import type { NarrativeCandidate, Signal } from "../types.js";

const CandidateSchema = z.object({
  narrative: z.string(),
  tickerSuggestion: z.string(),
  nameSuggestion: z.string(),
  angle: z.string(),
  whyNow: z.string(),
  score: z.number().min(0).max(100),
  crowdedness: z.enum(["none", "early", "crowded"]),
  sources: z.array(z.string()),
  category: z.string(),
});
const ResponseSchema = z.object({ candidates: z.array(CandidateSchema) });

/**
 * Skickar dagens signaler till Claude och får tillbaka scorade narrativ-kandidater.
 * provenPatterns = textsammanfattning av mönster ur proven_coins-tabellen (växer över tid).
 */
export async function scoreNarratives(
  signals: Signal[],
  provenPatterns: string,
): Promise<NarrativeCandidate[]> {
  if (!hasKey.anthropic()) {
    console.log("⚠️  Ingen ANTHROPIC_API_KEY — hoppar över scoring.");
    return [];
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const signalText = signals
    .slice(0, config.maxSignalsToScore)
    .map((s) => `- (${s.source}${s.score ? `, ${s.score}` : ""}) ${s.title}${s.url ? ` | ${s.url}` : ""}`)
    .join("\n");

  const prompt = `Du är narrativ-analytiker för en Solana-memecoin-deployer. Nedan är dagens råsignaler från nyheter, Hacker News, Google Trends, Reddit, X och DexScreener.

Ditt jobb:
1. Hitta ämnen som har MEMECOIN-potential: virala, roliga, absurda, känsloladdade, eller stora nyheter som går att invertera till något absurt. Cross-platform-träffar (samma ämne i 2+ källor) väger tungt.
2. Ignorera: vanliga börsnyheter, politik utan meme-vinkel, allt som redan är en etablerad stor coin.
3. För varje kandidat, föreslå ticker + namn. Formel som historiskt funkat: verklig händelse + absurd invertering, korta tickers, gärna fonetiska felstavningar.
4. Sätt score 0-100 baserat på: viralitet/velocity, memeability, timing-fönster (peakar det snart?), och crowdedness.
5. crowdedness: "none" = ingen coin finns rimligen än, "early" = kanske någon liten, "crowded" = finns säkert redan stora.

Mönster som historiskt bevisat funkat (från vår databas):
${provenPatterns || "(tomt än — databasen byggs upp över tid)"}

DAGENS SIGNALER:
${signalText}

Svara med ENDAST giltig JSON, exakt detta format:
{"candidates":[{"narrative":"...","tickerSuggestion":"$...","nameSuggestion":"...","angle":"...","whyNow":"...","score":0,"crowdedness":"none|early|crowded","sources":["url1"],"category":"..."}]}
Max 10 kandidater, bäst först.`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return ResponseSchema.parse(json).candidates;
  } catch (e) {
    console.error("Kunde inte parsa Claude-svar:", e);
    return [];
  }
}
