import { isDaytime } from "../github/alert.js";
import { handleNewToken, type NewTokenEvent } from "./handle.js";
import { popQueuedGithubCoins } from "./store.js";
import { sendGithubCoinMorningBrief } from "./alert.js";

const WS_URL = "wss://pumpportal.fun/api/data";

function parseTokenEvent(raw: unknown): NewTokenEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const inner = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : o;
  const mint = typeof inner.mint === "string" ? inner.mint : "";
  const uri = typeof inner.uri === "string" ? inner.uri : "";
  if (!mint || !uri) return null;
  const cap =
    typeof inner.marketCapSol === "number"
      ? inner.marketCapSol
      : typeof inner.usd_market_cap === "number"
        ? inner.usd_market_cap
        : null;
  return {
    mint,
    name: typeof inner.name === "string" ? inner.name : "",
    symbol: typeof inner.symbol === "string" ? inner.symbol : "",
    uri,
    marketCap: cap,
  };
}

async function maybeMorningBrief(): Promise<void> {
  if (!isDaytime()) return;
  const queued = await popQueuedGithubCoins();
  if (queued.length) {
    await sendGithubCoinMorningBrief(queued);
    console.log(`Morgonbrief: ${queued.length} nattfynd.`);
  }
}

export function connectLive(onStop: () => boolean): void {
  let delayMs = 1000;

  const connect = () => {
    if (onStop()) return;
    console.log(`🔌 pump-github live → ${WS_URL}`);
    const ws = new WebSocket(WS_URL);

    ws.addEventListener("open", () => {
      delayMs = 1000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      console.log("Prenumererar på nya tokens.");
      void maybeMorningBrief();
    });

    ws.addEventListener("message", (ev) => {
      void (async () => {
        try {
          const parsed: unknown = JSON.parse(String(ev.data));
          const batch = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of batch) {
            const token = parseTokenEvent(item);
            if (!token) continue;
            await handleNewToken(token, "live");
          }
          await maybeMorningBrief();
        } catch {
          /* ping/icke-JSON */
        }
      })();
    });

    ws.addEventListener("close", () => {
      if (onStop()) return;
      console.log(`WS stängd — reconnect om ${delayMs}ms`);
      setTimeout(connect, delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    });

    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  };

  connect();
}
