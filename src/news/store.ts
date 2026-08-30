import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type { NewsArticle, NewsCandidate, NewsExample } from "./types.js";

let client: SupabaseClient | null = null;

function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

export async function getNewsTopics(): Promise<string[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d
    .from("news_topics")
    .select("query")
    .eq("active", true)
    .order("created_at");
  if (error) {
    console.error("news_topics select:", error.message);
    return [];
  }
  return (data ?? []).map((row) => row.query as string);
}

export async function addNewsTopic(query: string, addedBy: string): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const clean = query.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) return false;

  const { data: existing } = await d
    .from("news_topics")
    .select("id")
    .ilike("query", clean)
    .maybeSingle();
  const operation = existing
    ? d
        .from("news_topics")
        .update({ active: true, added_by: addedBy, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    : d.from("news_topics").insert({ query: clean, added_by: addedBy });
  const { error } = await operation;
  if (error) console.error("news_topics add:", error.message);
  return !error;
}

export async function removeNewsTopic(query: string): Promise<boolean> {
  const d = db();
  if (!d) return false;
  const { data, error } = await d
    .from("news_topics")
    .update({ active: false, updated_at: new Date().toISOString() })
    .ilike("query", query.trim().replace(/\s+/g, " "))
    .select("id");
  if (error) console.error("news_topics remove:", error.message);
  return !error && (data?.length ?? 0) > 0;
}

export interface SaveNewsExampleInput {
  fingerprint: string;
  articleUrl: string;
  articleTitle: string;
  articleSummary: string;
  coinName: string;
  ticker: string;
  xPost: string;
  sourceMessage: string;
}

export async function saveNewsExample(
  example: SaveNewsExampleInput,
): Promise<{ id: number | null; duplicate: boolean; error: string | null }> {
  const d = db();
  if (!d) return { id: null, duplicate: false, error: "Supabase is not configured" };
  const row = {
    fingerprint: example.fingerprint,
    article_url: example.articleUrl,
    article_title: example.articleTitle || null,
    article_summary: example.articleSummary || null,
    coin_name: example.coinName,
    ticker: example.ticker,
    x_post: example.xPost,
    source_message: example.sourceMessage,
  };
  const { data, error } = await d
    .from("news_examples")
    .upsert(row, { onConflict: "fingerprint", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("news_examples insert:", error.message);
    return { id: null, duplicate: false, error: error.message };
  }
  if (data?.id) return { id: data.id as number, duplicate: false, error: null };

  const { data: existing, error: lookupError } = await d
    .from("news_examples")
    .select("id")
    .eq("fingerprint", example.fingerprint)
    .maybeSingle();
  if (lookupError) return { id: null, duplicate: false, error: lookupError.message };
  return { id: (existing?.id as number | undefined) ?? null, duplicate: true, error: null };
}

export async function getNewsExamples(limit = 60): Promise<NewsExample[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d
    .from("news_examples")
    .select("id, article_url, article_title, article_summary, coin_name, ticker, x_post, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("news_examples select:", error.message);
    return [];
  }
  return (data ?? []).map((row) => ({
    id: row.id as number,
    articleUrl: row.article_url as string,
    articleTitle: (row.article_title as string | null) ?? "",
    articleSummary: (row.article_summary as string | null) ?? "",
    coinName: row.coin_name as string,
    ticker: row.ticker as string,
    xPost: row.x_post as string,
    createdAt: row.created_at as string,
  }));
}

/** Reserverar nya artiklar atomiskt. Endast faktiskt insatta rader går vidare till Claude. */
export async function reserveNewArticles(articles: NewsArticle[]): Promise<NewsArticle[]> {
  if (articles.length === 0) return [];
  const d = db();
  if (!d) {
    console.error("News-scannern kräver Supabase för säker deduplicering; hoppar över artiklar.");
    return [];
  }
  const rows = articles.map((a) => ({
    fingerprint: a.fingerprint,
    title: a.title,
    source_name: a.sourceName,
    url: a.url,
    published_at: a.publishedAt,
    summary: a.summary,
    article_excerpt: a.articleExcerpt,
    matched_topics: a.matchedTopics,
    status: "pending",
  }));
  const { data, error } = await d
    .from("news_articles")
    .upsert(rows, { onConflict: "fingerprint", ignoreDuplicates: true })
    .select("fingerprint");
  if (error) {
    console.error("news_articles reserve:", error.message);
    return [];
  }
  const inserted = new Set((data ?? []).map((row) => row.fingerprint as string));
  return articles.filter((article) => inserted.has(article.fingerprint));
}

export async function getPendingNewsArticles(limit = 15): Promise<NewsArticle[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d
    .from("news_articles")
    .select("fingerprint, title, source_name, url, published_at, summary, article_excerpt, matched_topics")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("news_articles pending:", error.message);
    return [];
  }
  return (data ?? []).map((row) => ({
    fingerprint: row.fingerprint as string,
    title: row.title as string,
    sourceName: (row.source_name as string | null) ?? "Unknown source",
    url: row.url as string,
    publishedAt: (row.published_at as string | null) ?? null,
    summary: (row.summary as string | null) ?? "",
    articleExcerpt: (row.article_excerpt as string | null) ?? "",
    matchedTopics: Array.isArray(row.matched_topics) ? (row.matched_topics as string[]) : [],
  }));
}

export async function saveNewsResults(
  articles: NewsArticle[],
  candidates: NewsCandidate[],
  alertedFingerprints: Set<string>,
): Promise<void> {
  const d = db();
  if (!d) return;
  const byFingerprint = new Map(candidates.map((candidate) => [candidate.articleFingerprint, candidate]));
  await Promise.all(
    articles.map(async (article) => {
      const candidate = byFingerprint.get(article.fingerprint);
      const status = candidate
        ? alertedFingerprints.has(article.fingerprint)
          ? "alerted"
          : "analyzed"
        : "skipped";
      const { error } = await d
        .from("news_articles")
        .update({
          status,
          url: article.url,
          summary: article.summary,
          article_excerpt: article.articleExcerpt,
          score: candidate?.score ?? null,
          candidate: candidate ?? null,
          ready_post: candidate?.readyPost ?? null,
          analyzed_at: new Date().toISOString(),
        })
        .eq("fingerprint", article.fingerprint);
      if (error) console.error("news_articles update:", error.message);
    }),
  );
}
