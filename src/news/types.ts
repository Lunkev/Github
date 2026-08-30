export interface NewsArticle {
  fingerprint: string;
  title: string;
  sourceName: string;
  url: string;
  publishedAt: string | null;
  summary: string;
  articleExcerpt: string;
  matchedTopics: string[];
}

export interface NewsCandidate {
  articleFingerprint: string;
  nameSuggestion: string;
  tickerSuggestion: string;
  narrative: string;
  angle: string;
  whyNow: string;
  score: number;
  category: string;
}
