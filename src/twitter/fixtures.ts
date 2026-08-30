import type { TwitterTweet } from "./types.js";

export function tweetFixture(
  id: string,
  overrides: Partial<TwitterTweet> = {},
): TwitterTweet {
  return {
    id,
    text: "A zoo mascot escaped and was found riding a city bus.",
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    url: `https://x.com/example/status/${id}`,
    author: { userName: "example" },
    viewCount: 20_000,
    likeCount: 500,
    retweetCount: 100,
    replyCount: 20,
    quotedTweet: null,
    inReplyToId: null,
    ...overrides,
  };
}

export const multilingualTweets = [
  tweetFixture("101", { text: "El gato perdido volvió solo a casa." }),
  tweetFixture("102", { text: "動物園から逃げた猫が電車で発見された。" }),
  tweetFixture("103", { text: "Le chien mascotte a été retrouvé dans un café." }),
];

export const advancedSearchFixture = {
  tweets: multilingualTweets.map((tweet) => ({
    id: tweet.id,
    text: tweet.text,
    createdAt: tweet.createdAt,
    url: tweet.url,
    author: { userName: tweet.author.userName },
    viewCount: tweet.viewCount,
    likeCount: tweet.likeCount,
    retweetCount: tweet.retweetCount,
    replyCount: tweet.replyCount,
  })),
  has_next_page: false,
  next_cursor: "",
};
