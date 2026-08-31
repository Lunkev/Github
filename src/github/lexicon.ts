// Sök-lexikonet: seed-termer + inlärda termer från #proven (lexicon-tabellen i Supabase).
// Kevin skriver aldrig regler för hand — lexikonet växer när han skickar in bevisade fynd.

/** Seed-termer (Kevins egna + MYC-klassens mönster). Gemener — matchning är case-insensitive. */
export const SEED_TERMS: string[] = [
  "coin",
  "token name",
  "example token",
  "my coin",
  "test coin",
  "dog",
  "cat",
  "lynx",
  "mascot",
  "trading bot",
  "meme",
  "pepe",
  "wojak",
  "placeholder",
  "easter egg",
];

/** Regex-mönster som alltid gäller (ticker-liknande strängar etc). */
export const SEED_PATTERNS: RegExp[] = [
  /\$[A-Z]{2,8}\b/g, // $MYC, $KODA ...
  /"(?:name|symbol|ticker)"\s*:\s*"([^"]{2,30})"/gi, // metadata-exempel i JSON
  /\b(?:code\s*name|codename|mascot|project\s*name)\s*[:=]\s*["'`]([^"'`]{2,60})["'`]/gi,
  /\b(?:name|symbol|ticker)\s*[:=]\s*["'`]([^"'`]{2,40})["'`]/gi,
];

export interface LexiconHit {
  term: string;
  line: string;
  lineNumber: number;
  context: string;
}

function containsTerm(line: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Egna gränser i stället för \b: fungerar även för fraser och hindrar t.ex.
  // "cat" från att matcha "category", "catch" och "concatenate".
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(line);
}

/** Steg 1-filtret: dumt, snabbt, gratis. Returnerar rader som innehåller lexikon-träffar. */
export function matchLexicon(
  text: string,
  extraTerms: string[] = [],
  contextLines = 8,
): LexiconHit[] {
  const terms = [...SEED_TERMS, ...extraTerms.map((t) => t.toLowerCase())];
  const hits: LexiconHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const term =
      terms.find((t) => containsTerm(line, t)) ??
      SEED_PATTERNS.find((p) => (p.lastIndex = 0, p.test(line)))?.source;
    if (term) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      hits.push({
        term,
        line: line.trim().slice(0, 2000),
        lineNumber: i + 1,
        context: lines
          .slice(start, end)
          .map((value, offset) => `${start + offset + 1}: ${value}`)
          .join("\n")
          .slice(0, 12_000),
      });
    }
  }
  return hits;
}

export { isInterestingFile } from "./filePolicy.js";
