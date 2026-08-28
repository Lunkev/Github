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
];

export interface LexiconHit {
  term: string;
  line: string;
  lineNumber: number;
}

/** Steg 1-filtret: dumt, snabbt, gratis. Returnerar rader som innehåller lexikon-träffar. */
export function matchLexicon(text: string, extraTerms: string[] = []): LexiconHit[] {
  const terms = [...SEED_TERMS, ...extraTerms.map((t) => t.toLowerCase())];
  const hits: LexiconHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 500) continue; // minifierat/binärt skräp
    const lower = line.toLowerCase();
    const term =
      terms.find((t) => lower.includes(t)) ??
      SEED_PATTERNS.find((p) => (p.lastIndex = 0, p.test(line)))?.source;
    if (term) hits.push({ term, line: line.trim().slice(0, 300), lineNumber: i + 1 });
  }
  return hits;
}

/** Filer värda att läsa i en djupscan — docs, exempel, metadata. Inte varje kodrad. */
export function isInterestingFile(path: string, size: number): boolean {
  if (size > 200_000) return false;
  const p = path.toLowerCase();
  const ext = p.split(".").pop() ?? "";
  const goodExt = ["md", "mdx", "txt", "json", "yml", "yaml", "toml"].includes(ext);
  const goodDir = ["doc", "example", "reference", "metadata", "skill", "template", "asset"].some(
    (d) => p.includes(d),
  );
  return goodExt || goodDir;
}
