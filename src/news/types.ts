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
  readyPost: string;
}

export interface NewsExample {
  id: number;
  articleUrl: string;
  articleTitle: string;
  articleSummary: string;
  coinName: string;
  ticker: string;
  xPost: string;
  createdAt: string;
}
