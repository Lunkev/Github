/** Delad Discord webhook-POST. Returnerar false så callern kan behålla sin outbox. */

export async function postWebhook(url: string, content: string): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1990) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Discord-webhook svarade ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Discord-webhook:", e instanceof Error ? e.message : e);
    return false;
  }
}
