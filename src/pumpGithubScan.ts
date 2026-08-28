// Pump.fun → GitHub website-scanner (motsatt riktning mot githubScan).
//   npm run pump-github              live websocket
//   npm run pump-github -- --selftest  CyberLeek extensions.website (ingen GitHub-träff)
//   npm run pump-github -- --once <uri>  hämta en metadata-URI och visa resultat
import { extractTwitter, extractWebsite, parseGithubUrl, parseStatusUrl } from "./pumpGithub/check.js";
import { fetchMetadata } from "./pumpGithub/meta.js";
import { connectLive } from "./pumpGithub/live.js";

const CYBERLEEK_URI =
  "https://gateway.pinata.cloud/ipfs/bafkreibepim3k3ykk6lh4ny6a3zvq4aajlawnhcnk6jqjqb7oy3vke4xfi";

function selftest(): number {
  const meta = {
    name: "CyberLeek",
    extensions: { website: "https://leek.ar.io" },
  };
  const site = extractWebsite(meta);
  const gh = site ? parseGithubUrl(site) : null;
  const tw = extractTwitter({ twitter: "https://x.com/foo/status/1234567890123456789" });
  const status = tw ? parseStatusUrl(tw) : null;
  const twitterOk = status?.id === "1234567890123456789";
  const profileIgnored = parseStatusUrl("https://x.com/elonmusk") === null;
  console.log(`selftest website: ${site}`);
  console.log(`selftest github: ${gh ? gh.url : "(none — expected)"}`);
  console.log(`selftest status id: ${status?.id ?? "(none)"}`);
  const ok = site === "https://leek.ar.io" && gh === null && twitterOk && profileIgnored;
  if (!ok) {
    console.error("selftest FAILED");
    return 1;
  }
  console.log("✅ selftest OK (extensions.website parsed, no GitHub hit)");
  return 0;
}

async function once(uri: string): Promise<number> {
  console.log(`Hämtar ${uri} ...`);
  const meta = await fetchMetadata(uri);
  if (!meta) {
    console.log("Ingen metadata (blocklist, 403, eller timeout).");
    return 1;
  }
  const site = extractWebsite(meta);
  console.log(`website: ${site ?? "(saknas)"}`);
  const gh = site ? parseGithubUrl(site) : null;
  console.log(`github: ${gh ? gh.url : "(ingen träff — rätt om sajten inte är GitHub)"}`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    process.exitCode = selftest();
    return;
  }
  const onceIdx = args.indexOf("--once");
  if (onceIdx >= 0) {
    const uri = args[onceIdx + 1] || CYBERLEEK_URI;
    process.exitCode = await once(uri);
    return;
  }

  console.log("pump-github live — Ctrl+C för att stoppa\n");
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  connectLive(() => stopped);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
