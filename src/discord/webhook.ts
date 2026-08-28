/** Delad Discord webhook-POST. Aldrig throw. */

export async function postWebhook(url: string, content: string): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1990) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`Discord-webhook svarade ${res.status}`);
  } catch (e) {
    console.error("Discord-webhook:", e instanceof Error ? e.message : e);
  }
}
