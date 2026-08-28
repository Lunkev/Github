import { config, hasKey } from "../config.js";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchViaTwitterApiIo(id: string): Promise<string | null> {
  if (!hasKey.twitter()) return null;
  try {
    const res = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${id}`, {
      headers: { "X-API-Key": config.twitterApiIoKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tweets?: { text?: string }[] };
    const text = data.tweets?.[0]?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

async function fetchViaOembed(statusUrl: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(statusUrl)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { html?: string };
    if (!data.html) return null;
    const text = stripHtml(data.html);
    return text || null;
  } catch {
    return null;
  }
}

/** Hämta tweet-text. Aldrig throw. Misslyckande → null (alert går ut ändå). */
export async function fetchTweetText(id: string, statusUrl: string): Promise<string | null> {
  const viaApi = await fetchViaTwitterApiIo(id);
  if (viaApi) return viaApi;
  return fetchViaOembed(statusUrl);
}
