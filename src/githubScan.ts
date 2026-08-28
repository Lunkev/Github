// GitHub-scannern — entrypoint. Körs varje timme av .github/workflows/github-scan.yml.
//   npm run github          skarp körning
//   npm run github -- --dry torrkörning: bara insamling + lexikonfilter, ingen AI/Discord/DB
import { listOrgRepos } from "./github/api.js";
import { deepScan, diffScan, type RawHit } from "./github/scan.js";
import { judgeHits } from "./github/judge.js";
import { sendAlerts, sendMorningBrief, isDaytime } from "./github/alert.js";
import { ingestWatchlist, ingestProven } from "./discord/ingest.js";
import {
  getWatchlist,
  getLearnedTerms,
  getState,
  setState,
  saveFindings,
  popQueuedFindings,
} from "./db/githubStore.js";
import { getProvenPatterns } from "./db/supabase.js";

const DRY = process.argv.includes("--dry");
const MAX_DEEP_SCANS_PER_RUN = 2; // rate limit-hygien; resten tas nästa timme

async function main() {
  console.log(`🔍 github-scan ${DRY ? "(torrkörning)" : ""} — ${new Date().toISOString()}\n`);

  // 1. Läs in nya Discord-inskick (watchlist + proven) — inte i dry-läge.
  if (!DRY) {
    const added = await ingestWatchlist();
    if (added.length) console.log("Watchlist +", added.join(", "));
    const proven = await ingestProven();
    if (proven) console.log(`#proven: ${proven} nya inskick strukturerade.`);
  }

  // 2. Watchlist -> konkreta repos. Org-poster expanderas till orgens repos
  //    (att lägga till en org = ok att skanna dess repos; nya repos flaggas i loggen).
  const watchlist = await getWatchlist();
  const learnedTerms = DRY ? [] : await getLearnedTerms();
  const repos: string[] = [];
  for (const entry of watchlist) {
    if (entry.target.includes("/")) {
      repos.push(entry.target);
    } else {
      const orgRepos = await listOrgRepos(entry.target);
      repos.push(...orgRepos.slice(0, 15).map((r) => `${entry.target}/${r.name}`));
    }
  }
  console.log(`Bevakar ${repos.length} repos (${learnedTerms.length} inlärda lexikon-termer).\n`);

  // 3. Skanna: djupscan för nya repos (max N per körning), diff-vakt för resten.
  const lastRun = (await getState("last_github_run")) ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const allHits: RawHit[] = [];
  let deepScansUsed = 0;
  for (const repoFull of repos) {
    const [owner, repo] = repoFull.split("/");
    const deepKey = `deep_scanned_${repoFull}`;
    const alreadyDeep = DRY ? true : (await getState(deepKey)) !== null;
    if (!alreadyDeep && deepScansUsed < MAX_DEEP_SCANS_PER_RUN) {
      console.log(`  djupscan: ${repoFull} ...`);
      allHits.push(...(await deepScan({ owner, repo }, learnedTerms)));
      await setState(deepKey, new Date().toISOString());
      deepScansUsed++;
    } else {
      allHits.push(...(await diffScan({ owner, repo }, lastRun, learnedTerms)));
    }
  }
  console.log(`Råträffar från lexikonfiltret: ${allHits.length}`);

  if (DRY) {
    for (const h of allHits.slice(0, 30))
      console.log(`  · ${h.repo} ${h.path}:${h.lineNumber} [${h.term}] "${h.line.slice(0, 80)}"`);
    console.log("\n✅ Torrkörning klar. Kör utan --dry för bedömning + alerts.");
    return;
  }

  // 4. Claude bedömer, DexScreener-kollar, alerts går ut (natt-hot köas).
  const findings = await judgeHits(allHits, await getProvenPatterns());
  console.log(`Fynd efter bedömning: ${findings.length}`);
  const queued = await sendAlerts(findings);
  await saveFindings(findings, queued);

  // 5. Morgonbrief: första dagtidskörningen tömmer nattkön.
  if (isDaytime()) {
    const nightFinds = await popQueuedFindings();
    await sendMorningBrief(nightFinds);
    if (nightFinds.length) console.log(`Morgonbrief skickad med ${nightFinds.length} nattfynd.`);
  }

  await setState("last_github_run", new Date().toISOString());
  console.log("✅ Klart.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
