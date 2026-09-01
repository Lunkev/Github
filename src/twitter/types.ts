export interface TwitterQuery {
  id: number;
  query: string;
}

export interface TwitterAuthor {
  userName: string;
  name?: string;
}

export interface TwitterTweet {
  id: string;
  text: string;
  createdAt: string;
  url: string;
  author: TwitterAuthor;
  viewCount: number;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quotedTweet?: TwitterTweet | null;
  inReplyToId?: string | null;
}

export interface TwitterOrigin extends TwitterTweet {
  sourceThread: TwitterTweet[];
  matchedQueryIds: number[];
  approximateVelocity: number;
  observedVelocity: number | null;
  status: string;
  attemptCount: number;
  judgeAttemptCount: number;
  writerAttemptCount: number;
  decision?: TwitterDecision | null;
  readyPost?: string | null;
}

export interface TwitterDecision {
  approved: boolean;
  score: number;
  coinName: string;
  ticker: string;
  narrative: string;
  category: string;
  reasoning: string;
}

export interface TwitterExample {
  id: number;
  originUrl: string;
  originText: string;
  coinName: string;
  ticker: string;
  xPost: string;
  createdAt: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface TwitterRunMetrics {
  queriesClaimed: number;
  searchCalls: number;
  lookupCalls: number;
  emptyTwitterCalls: number;
  returnedTweets: number;
  originsSaved: number;
  originsWatching: number;
  originsImmediate: number;
  originsConfirmed: number;
  originsExpired: number;
  originsJudged: number;
  postsWritten: number;
  alertsSent: number;
  usage: TokenUsage;
}
