// GitHub-scannern — entrypoint. Körs varje timme av .github/workflows/github-scan.yml.
//   npm run github          skarp körning
//   npm run github -- --dry torrkörning: bara insamling + lexikonfilter, ingen AI/Discord/DB
import { listOrgRepos, getHeadCommit } from "./github/api.js";
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
  filterUnseenHits,
  filterUnseenFindings,
} from "./db/githubStore.js";
import { getProvenPatterns } from "./db/supabase.js";

const DRY = process.argv.includes("--dry");
const MAX_DEEP_SCANS_PER_RUN = 2; // rate limit-hygien; resten tas nästa timme

interface ScanTarget {
  full: string; // owner/repo
  isNewToOrg: boolean;
}

async function main() {
  console.log(`🔍 github-scan ${DRY ? "(torrkörning)" : ""} — ${new Date().toISOString()}\n`);

  // 1. Läs in nya Discord-inskick (watchlist + proven) — inte i dry-läge.
  if (!DRY) {
    const added = await ingestWatchlist();
    if (added.length) console.log("Watchlist +", added.join(", "));
    const proven = await ingestProven();
    if (proven) console.log(`#proven: ${proven} nya inskick strukturerade.`);
  }

  // 2. Watchlist -> konkreta repos. Org-poster expanderas; nya repos i org prioriteras för djupscan.
  const watchlist = await getWatchlist();
  const learnedTerms = DRY ? [] : await getLearnedTerms();
  const targets: ScanTarget[] = [];
  const orgSeenUpdates: { key: string; repos: string[] }[] = [];

  for (const entry of watchlist) {
    if (entry.target.includes("/")) {
      targets.push({ full: entry.target, isNewToOrg: false });
      continue;
    }
    const orgRepos = await listOrgRepos(entry.target);
    const current = orgRepos.slice(0, 15).map((r) => `${entry.target}/${r.name}`);
    const seenKey = `seen_repos_${entry.target}`;
    const seenRaw = DRY ? null : await getState(seenKey);
    let seen: string[] = [];
    if (seenRaw) {
      try {
        seen = JSON.parse(seenRaw) as string[];
      } catch {
        seen = [];
      }
    }
    const seenSet = new Set(seen);
    // Första snapshot: alla är baslinje, inte "nya". Därefter är diff mot sedda = nya repos.
    for (const full of current) {
      targets.push({ full, isNewToOrg: seen.length > 0 && !seenSet.has(full) });
    }
    if (!DRY) orgSeenUpdates.push({ key: seenKey, repos: current });
  }

  targets.sort((a, b) => Number(b.isNewToOrg) - Number(a.isNewToOrg));
  console.log(`Bevakar ${targets.length} repos (${learnedTerms.length} inlärda lexikon-termer).\n`);

  // 3. Skanna: djupscan för nya/oskannade repos (max N per körning), SHA-diff för resten.
  const allHits: RawHit[] = [];
  let deepScansUsed = 0;
  for (const t of targets) {
    const [owner, repo] = t.full.split("/");
    const ref = { owner, repo };
    const deepKey = `deep_scanned_${t.full}`;
    const shaKey = `last_sha_${t.full}`;
    const alreadyDeep = DRY ? true : (await getState(deepKey)) !== null;
    if (!alreadyDeep && deepScansUsed < MAX_DEEP_SCANS_PER_RUN) {
      console.log(`  djupscan: ${t.full}${t.isNewToOrg ? " (nytt i org)" : ""} ...`);
      allHits.push(...(await deepScan(ref, learnedTerms)));
      await setState(deepKey, new Date().toISOString());
      const head = await getHeadCommit(ref);
      if (head) await setState(shaKey, head.sha);
      deepScansUsed++;
    } else {
      if (t.isNewToOrg) console.log(`  nytt repo i org (diff tills djupscan-slot): ${t.full}`);
      const lastSha = DRY ? null : await getState(shaKey);
      const { hits, headSha } = await diffScan(ref, learnedTerms, lastSha);
      allHits.push(...hits);
      if (!DRY && headSha) await setState(shaKey, headSha);
    }
  }
  for (const u of orgSeenUpdates) await setState(u.key, JSON.stringify(u.repos));
  console.log(`Råträffar från lexikonfiltret: ${allHits.length}`);

  if (DRY) {
    for (const h of allHits.slice(0, 30))
      console.log(`  · ${h.repo} ${h.path}:${h.lineNumber} [${h.term}] "${h.line.slice(0, 80)}"`);
    console.log("\n✅ Torrkörning klar. Kör utan --dry för bedömning + alerts.");
    return;
  }

  // 4. Hoppa redan sedda rader → Claude → fingerprint-dedup → spara → alert (tyst om tomt).
  const freshHits = await filterUnseenHits(allHits);
  if (freshHits.length < allHits.length) {
    console.log(`Hoppar ${allHits.length - freshHits.length} redan sparade rader före bedömning.`);
  }
  const judged = await judgeHits(freshHits, await getProvenPatterns());
  const findings = await filterUnseenFindings(judged);
  console.log(`Fynd efter bedömning: ${judged.length} (nya: ${findings.length})`);

  const queued = isDaytime() ? [] : findings.filter((f) => f.verdict === "hot");
  await saveFindings(findings, queued);
  await sendAlerts(findings);

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
