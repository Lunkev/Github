import { createHash } from "node:crypto";
import Parser from "rss-parser";
import { config } from "../config.js";
import type { NewsArticle } from "./types.js";

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "narrative-scanner/1.0" },
});

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function plainText(value: string): string {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value: string): string {
  return plainText(value).replace(/\s+/g, " ").trim();
}

export function newsFingerprint(title: string, sourceName: string): string {
  const key = `${normalizeTitle(title).toLowerCase()}|${sourceName.trim().toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex");
}

function sourceAndTitle(rawTitle: string, rawSource: unknown): { title: string; sourceName: string } {
  let sourceName = "";
  if (typeof rawSource === "string") sourceName = plainText(rawSource);
  if (rawSource && typeof rawSource === "object") {
    const source = rawSource as Record<string, unknown>;
    const text = source._ ?? source["#"];
    if (typeof text === "string") sourceName = plainText(text);
  }

  let title = normalizeTitle(rawTitle);
  if (!sourceName) {
    const splitAt = title.lastIndexOf(" - ");
    if (splitAt > 0) {
      sourceName = title.slice(splitAt + 3).trim();
      title = title.slice(0, splitAt).trim();
    }
  } else if (title.toLowerCase().endsWith(` - ${sourceName.toLowerCase()}`)) {
    title = title.slice(0, -(sourceName.length + 3)).trim();
  }
  return { title, sourceName: sourceName || "Unknown source" };
}

function googleNewsUrl(query: string): string {
  const q = encodeURIComponent(`${query} when:1d`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

async function fetchTopic(query: string): Promise<NewsArticle[]> {
  try {
    const feed = await parser.parseURL(googleNewsUrl(query));
    const cutoff = Date.now() - config.freshnessHours * 3_600_000;
    return (feed.items ?? []).flatMap((raw) => {
      const item = raw as Record<string, unknown>;
      const url = typeof item.link === "string" ? item.link : "";
      const rawTitle = typeof item.title === "string" ? item.title : "";
      if (!url || !rawTitle) return [];

      const publishedRaw =
        typeof item.isoDate === "string"
          ? item.isoDate
          : typeof item.pubDate === "string"
            ? item.pubDate
            : "";
      const timestamp = publishedRaw ? Date.parse(publishedRaw) : NaN;
      if (!Number.isNaN(timestamp) && timestamp < cutoff) return [];

      const { title, sourceName } = sourceAndTitle(rawTitle, item.source);
      const summaryRaw =
        typeof item.contentSnippet === "string"
          ? item.contentSnippet
          : typeof item.content === "string"
            ? item.content
            : typeof item.description === "string"
              ? item.description
              : "";
      return [{
        fingerprint: newsFingerprint(title, sourceName),
        title,
        sourceName,
        url,
        publishedAt: Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString(),
        summary: plainText(summaryRaw).slice(0, 1_500),
        articleExcerpt: "",
        matchedTopics: [query],
      }];
    });
  } catch (error) {
    console.error(`Google News "${query}":`, error instanceof Error ? error.message : error);
    return [];
  }
}

export async function fetchGoogleNews(topics: string[]): Promise<NewsArticle[]> {
  const batches = await Promise.all(topics.map(fetchTopic));
  const unique = new Map<string, NewsArticle>();
  for (const article of batches.flat()) {
    const existing = unique.get(article.fingerprint);
    if (existing) {
      existing.matchedTopics = [...new Set([...existing.matchedTopics, ...article.matchedTopics])];
      if (article.summary.length > existing.summary.length) existing.summary = article.summary;
    } else {
      unique.set(article.fingerprint, article);
    }
  }
  return [...unique.values()].sort(
    (a, b) => Date.parse(b.publishedAt ?? "1970-01-01") - Date.parse(a.publishedAt ?? "1970-01-01"),
  );
}

function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const first = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
  );
  const reversed = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  );
  return plainText(first?.[1] ?? reversed?.[1] ?? "");
}

async function fetchPageContext(url: string): Promise<{
  finalUrl: string;
  title: string;
  summary: string;
  excerpt: string;
}> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; narrative-scanner/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { finalUrl: url, title: "", summary: "", excerpt: "" };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return { finalUrl: res.url || url, title: "", summary: "", excerpt: "" };
    const html = (await res.text()).slice(0, 750_000);
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const title = metaContent(html, "og:title") || plainText(titleTag);
    const summary =
      metaContent(html, "og:description") ||
      metaContent(html, "description") ||
      metaContent(html, "twitter:description");
    const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => plainText(match[1]))
      .filter((text) => text.length >= 60)
      .slice(0, 8)
      .join("\n");
    return {
      finalUrl: res.url || url,
      title: title.slice(0, 300),
      summary: summary.slice(0, 1_500),
      excerpt: paragraphs.slice(0, 4_000),
    };
  } catch {
    return { finalUrl: url, title: "", summary: "", excerpt: "" };
  }
}

/** Best-effort enrichment. Betalvägg/blockering lämnar RSS-datan orörd. */
export async function enrichArticle(article: NewsArticle): Promise<NewsArticle> {
  const context = await fetchPageContext(article.url);
  const finalHost = (() => {
    try {
      return new URL(context.finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const isGoogleIntermediary = finalHost.endsWith("google.com");
  if (isGoogleIntermediary) return article;
  return {
    ...article,
    url: context.finalUrl,
    summary: context.summary || article.summary,
    articleExcerpt: context.excerpt,
  };
}

export async function fetchManualArticle(url: string): Promise<NewsArticle | null> {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const context = await fetchPageContext(url);
    const finalUrl = context.finalUrl || url;
    const sourceName = new URL(finalUrl).hostname.replace(/^www\./, "");
    const title = context.title || parsed.pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]/g, " ") || url;
    return {
      fingerprint: newsFingerprint(title, sourceName),
      title,
      sourceName,
      url: finalUrl,
      publishedAt: new Date().toISOString(),
      summary: context.summary,
      articleExcerpt: context.excerpt,
      matchedTopics: ["manual"],
    };
  } catch {
    return null;
  }
}
