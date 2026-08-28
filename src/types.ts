// Gemensamma typer för hela pipelinen.

/** En rå signal från valfri källa — normaliserad så allt nedströms är källoberoende. */
export interface Signal {
  source:
    | "rss-news"
    | "hackernews"
    | "google-trends"
    | "reddit"
    | "twitter"
    | "tiktok"
    | "dexscreener";
  title: string;
  url?: string;
  /** Källspecifik styrka: HN-poäng, Reddit-upvotes, sökvolym, volym i USD, etc. */
  score?: number;
  publishedAt?: string; // ISO
  extra?: Record<string, unknown>;
}

/** En scorad narrativ-kandidat från Claude. */
export interface NarrativeCandidate {
  narrative: string; // en mening
  tickerSuggestion: string; // t.ex. "$HONSE"
  nameSuggestion: string;
  angle: string; // vinkel / bild-idé / varför det är roligt
  whyNow: string; // timing-motivering
  score: number; // 0-100
  crowdedness: "none" | "early" | "crowded"; // finns coins redan?
  sources: string[]; // URLs som stödjer narrativet
  category: string; // t.ex. "animal-viral", "ai-release", "breaking-news", "celebrity"
}

export interface ScanResult {
  ranAt: string;
  signals: Signal[];
  candidates: NarrativeCandidate[];
}
