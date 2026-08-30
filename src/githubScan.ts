// GitHub-scannern — discovery och processing är separerade av en varaktig kö.
// En timeout eller budgetpaus kan därför skapa fördröjning men aldrig tyst bortfall.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { config } from "./config.js";
import {
  getGithubApiCallCount,
  getHeadCommit,
  getTree,
  listCommitsAfter,
  listOrgRepos,
  resetGithubApiCallCount,
  type CommitRef,
  type RepoRef,
} from "./github/api.js";
import {
  chunkText,
  extractRuleHits,
  extractUnit,
  patchIsComplete,
  type TextChunk,
} from "./github/scan.js";
import { extractCandidatesWithHaiku } from "./github/candidateExtractor.js";
import { judgeHits } from "./github/judge.js";
import { runScannerFixtureTests } from "./github/selftest.js";
import {
  sendAlerts,
  sendMorningBrief,
  sendOperationalAlert,
  isDaytime,
} from "./github/alert.js";
import { ingestWatchlist, ingestProven } from "./discord/ingest.js";
import {
  getWatchlist,
  getLearnedTerms,
  getState,
  setState,
  saveFindings,
  popQueuedFindings,
  clearQueuedFindings,
  filterUnseenFindings,
} from "./db/githubStore.js";
import { getProvenPatterns } from "./db/supabase.js";
import {
  assertQueueSchema,
  auditUnit,
  candidateFingerprint,
  claimCandidates,
  claimUnits,
  completeUnit,
  createRun,
  enqueueUnits,
  failUnit,
  finishCandidates,
  getAuditCount,
  getBacklogCount,
  getMonthlyUsage,
  getRepoState,
  saveCandidates,
  saveRepoState,
  unitFingerprint,
  updateRun,
  type ScanUnit,
  type ScanUnitInput,
  type UsageTotals,
} from "./github/unitStore.js";

const DRY = process.argv.includes("--dry");
const SELFTEST = process.argv.includes("--selftest");

function zeroUsage(): UsageTotals {
  return { haikuInput: 0, haikuOutput: 0, sonnetInput: 0, sonnetOutput: 0 };
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
  target.haikuInput += source.haikuInput;
  target.haikuOutput += source.haikuOutput;
  target.sonnetInput += source.sonnetInput;
  target.sonnetOutput += source.sonnetOutput;
}

export function estimateClaudeCost(usage: UsageTotals): number {
  return (
    usage.haikuInput / 1_000_000 +
    (usage.haikuOutput / 1_000_000) * 5 +
    (usage.sonnetInput / 1_000_000) * 3 +
    (usage.sonnetOutput / 1_000_000) * 15
  );
}

function refFromFull(full: string): RepoRef {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`Ogiltigt repo: ${full}`);
  return { owner, repo };
}

function commitUnit(repo: string, commit: CommitRef): ScanUnitInput {
  return {
    repo,
    kind: "commit",
    commitSha: commit.sha,
    parentSha: commit.parentSha,
    payload: { message: commit.message, date: commit.date, url: commit.url },
  };
}

function chunkUnit(parent: ScanUnit, chunk: TextChunk, index: number): ScanUnitInput {
  const contentHash = createHash("sha256").update(chunk.text).digest("hex");
  return {
    repo: parent.repo,
    kind: "text_chunk",
    commitSha: parent.commitSha,
    parentSha: parent.fingerprint,
    path: chunk.path,
    blobSha: `${index}:${contentHash}`,
    payload: {
      text: chunk.text,
      startLine: chunk.startLine,
      url: chunk.url,
      mode: chunk.mode,
      commitMessage: chunk.commitMessage ?? null,
    },
  };
}

function chunkFromUnit(unit: ScanUnit): TextChunk {
  const payload = unit.payload ?? {};
  if (typeof payload.text !== "string" || typeof payload.url !== "string") {
    throw new Error(`text_chunk har ogiltig payload: ${unit.fingerprint}`);
  }
  return {
    repo: unit.repo,
    path: unit.path ?? "(unknown)",
    url: payload.url,
    mode: payload.mode === "deep" ? "deep" : "diff",
    commitSha: unit.commitSha,
    commitMessage: typeof payload.commitMessage === "string" ? payload.commitMessage : undefined,
    startLine: Number(payload.startLine ?? 1),
    text: payload.text,
  };
}

async function expandTargets(): Promise<{ targets: string[]; newRepos: string[] }> {
  const watchlist = await getWatchlist();
  const targets = new Set<string>();
  const newRepos: string[] = [];
  for (const entry of watchlist) {
    if (entry.target.includes("/")) {
      targets.add(entry.target);
      continue;
    }
    const orgRepos = await listOrgRepos(entry.target);
    const current = orgRepos.map((repo) => `${entry.target}/${repo.name}`);
    const seenKey = `seen_repos_${entry.target}`;
    const seenRaw = DRY ? null : await getState(seenKey);
    let seen: string[] = [];
    if (seenRaw) {
      try {
        seen = JSON.parse(seenRaw) as string[];
      } catch { /* trasig gammal snapshot blir en ny baslinje */ }
    }
    const seenSet = new Set(seen);
    for (const full of current) {
      targets.add(full);
      if (seen.length > 0 && !seenSet.has(full)) newRepos.push(full);
    }
    if (!DRY) await setState(seenKey, JSON.stringify([...new Set([...seen, ...current])]));
  }
  return { targets: [...targets].sort(), newRepos };
}

async function enqueueBaseline(repo: string, ref: RepoRef, headSha: string): Promise<number> {
  const tree = await getTree(ref, headSha);
  const units: ScanUnitInput[] = tree.map((file) => ({
    repo,
    kind: "deep_file",
    commitSha: headSha,
    path: file.path,
    blobSha: file.sha,
    payload: { size: file.size },
  }));
  let inserted = 0;
  for (let i = 0; i < units.length; i += 500) inserted += await enqueueUnits(units.slice(i, i + 500));
  await saveRepoState(repo, {
    baselineSha: headSha,
    baselineComplete: true,
    lastDiscoveredSha: headSha,
    lastError: null,
  });
  return inserted;
}

async function discoverRepo(repo: string): Promise<{ enqueued: number; warning?: string }> {
  const ref = refFromFull(repo);
  const state = await getRepoState(repo);
  let legacySha: string | null = null;
  if (!state) {
    // Gamla deep_scanned-flaggor skapades av en 300-filsbegränsad scanner och
    // får aldrig certifiera den nya fulla baslinjen. SHA:n används bara för
    // att köa övergångscommits före den nya trädbaslinjen.
    legacySha = await getState(`last_sha_${repo}`);
  }
  const head = await getHeadCommit(ref);
  if (!head) {
    await saveRepoState(repo, { lastError: "Repot saknar commits eller HEAD kunde inte läsas." });
    return { enqueued: 0, warning: `${repo}: saknar läsbar HEAD` };
  }

  if (!state?.baselineComplete || !state.lastDiscoveredSha) {
    let enqueued = 0;
    let warning: string | undefined;
    if (legacySha) {
      const transition = await listCommitsAfter(ref, legacySha);
      if (transition.cursorFound) {
        for (let i = 0; i < transition.commits.length; i += 500) {
          enqueued += await enqueueUnits(
            transition.commits.slice(i, i + 500).map((commit) => commitUnit(repo, commit)),
          );
        }
      } else {
        warning = `${repo}: gammal cursor var orphan; full ny baslinje köades men omskrivna övergångscommits kan inte återställas.`;
      }
    }
    enqueued += await enqueueBaseline(repo, ref, head.sha);
    return { enqueued, warning };
  }

  const discovery = await listCommitsAfter(ref, state.lastDiscoveredSha);
  if (!discovery.cursorFound) {
    const enqueued = await enqueueBaseline(repo, ref, head.sha);
    return {
      enqueued,
      warning: `${repo}: sparad cursor finns inte längre i historiken (force-push/rewrite). Ny full baslinje köades.`,
    };
  }
  let enqueued = 0;
  for (let i = 0; i < discovery.commits.length; i += 500) {
    enqueued += await enqueueUnits(discovery.commits.slice(i, i + 500).map((commit) => commitUnit(repo, commit)));
  }
  // Cursorn flyttas först efter att samtliga commits ovan ligger varaktigt i DB.
  if (discovery.headSha) {
    await saveRepoState(repo, { lastDiscoveredSha: discovery.headSha, lastError: null });
  }
  return { enqueued };
}

async function dryRun(targets: string[], learnedTerms: string[]): Promise<void> {
  for (const repo of targets.slice(0, 3)) {
    const ref = refFromFull(repo);
    const head = await getHeadCommit(ref);
    if (!head) continue;
    const unit: ScanUnit = {
      ...commitUnit(repo, head),
      fingerprint: unitFingerprint(commitUnit(repo, head)),
      status: "pending",
      attemptCount: 0,
    };
    const extraction = await extractUnit(unit);
    const chunks = [...extraction.chunks];
    for (const child of extraction.childUnits) {
      const childUnit: ScanUnit = {
        ...child,
        fingerprint: unitFingerprint(child),
        status: "pending",
        attemptCount: 0,
      };
      const childExtraction = await extractUnit(childUnit);
      chunks.push(...childExtraction.chunks);
    }
    const hits = extractRuleHits(chunks, learnedTerms);
    console.log(`${repo}: ${chunks.length} chunks, ${hits.length} regelträffar`);
    for (const hit of hits.slice(0, 10)) {
      console.log(`  · ${hit.path}:${hit.lineNumber} [${hit.term}] "${hit.line.slice(0, 100)}"`);
    }
  }
}

async function main() {
  console.log(`github-scan ${DRY ? "(torrkörning)" : ""} — ${new Date().toISOString()}\n`);
  resetGithubApiCallCount();

  if (!DRY) await assertQueueSchema();
  if (!DRY) {
    const added = await ingestWatchlist();
    if (added.length) console.log("Watchlist +", added.join(", "));
    const proven = await ingestProven();
    if (proven) console.log(`#proven: ${proven} nya inskick strukturerade.`);
  }

  const learnedTerms = DRY ? [] : await getLearnedTerms();
  const { targets, newRepos } = await expandTargets();
  console.log(`Bevakar ${targets.length} repos (${learnedTerms.length} inlärda lexikon-termer).`);
  if (DRY) {
    await dryRun(targets, learnedTerms);
    console.log("Torrkörning klar; ingen AI, Discord eller DB-kö ändrades.");
    return;
  }

  const runId = await createRun(false);
  const startedAt = Date.now();
  const deadline = startedAt + config.githubRunDeadlineMinutes * 60_000;
  const runUsage = zeroUsage();
  const priorUsage = await getMonthlyUsage();
  let unitsEnqueued = 0;
  let unitsProcessed = 0;
  let findingsNew = 0;
  const warnings = newRepos.length ? [`Nya repos i bevakade orgs: ${newRepos.join(", ")}`] : [];
  const recordUsage = async (usage: UsageTotals): Promise<void> => {
    addUsage(runUsage, usage);
    await updateRun(runId, { usage: runUsage, unitsProcessed, unitsEnqueued });
  };

  try {
    // Discovery får alltid gå före AI-drain: nya commits säkras även vid stor backlog.
    for (const repo of targets) {
      if (Date.now() >= deadline) {
        warnings.push(`Discovery nådde tidsbudgeten efter ${repo}; resterande repos tas nästa timme.`);
        break;
      }
      try {
        const result = await discoverRepo(repo);
        unitsEnqueued += result.enqueued;
        if (result.warning) warnings.push(result.warning);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveRepoState(repo, { lastError: message }).catch(() => undefined);
        warnings.push(`${repo}: discovery-fel, cursorn flyttades inte: ${message}`);
      }
    }

    // Extraktion och Haiku körs unit-för-unit. Texten blir en egen hållbar
    // chunk-unit innan AI-anropet, så stora filer kan återupptas säkert.
    while (unitsProcessed < config.githubMaxUnitsPerRun && Date.now() < deadline) {
      const totalUsage = { ...priorUsage };
      addUsage(totalUsage, runUsage);
      if (estimateClaudeCost(totalUsage) >= config.githubClaudeMonthlyBudgetUsd) break;
      const [unit] = await claimUnits(1);
      if (!unit) break;
      try {
        if (unit.kind !== "text_chunk") {
          const beforeCalls = getGithubApiCallCount();
          const extraction = await extractUnit(unit);
          for (let i = 0; i < extraction.childUnits.length; i += 500) {
            unitsEnqueued += await enqueueUnits(extraction.childUnits.slice(i, i + 500));
          }
          const chunkUnits = extraction.chunks.map((chunk, index) => chunkUnit(unit, chunk, index));
          for (let i = 0; i < chunkUnits.length; i += 500) {
            unitsEnqueued += await enqueueUnits(chunkUnits.slice(i, i + 500));
          }
          const calls = getGithubApiCallCount() - beforeCalls;
          if (extraction.auditReasons.length > 0) {
            await auditUnit(unit, extraction.auditReasons.join("\n"), calls);
            warnings.push(...extraction.auditReasons.map((reason) => `${unit.repo}: ${reason}`));
          } else {
            await completeUnit(unit.fingerprint, calls, extraction.chunks.length);
          }
          unitsProcessed++;
          continue;
        }

        const chunk = chunkFromUnit(unit);
        const ruleHits = extractRuleHits([chunk], learnedTerms);
        const ruleRecords = ruleHits.map((hit) => {
          const fingerprint = candidateFingerprint(unit.fingerprint, hit);
          return { fingerprint, unitFingerprint: unit.fingerprint, hit, source: "rule" as const };
        });
        // Deterministiska träffar sparas även om Haiku tillfälligt ligger nere.
        await saveCandidates(ruleRecords);

        const haiku = await extractCandidatesWithHaiku([chunk], recordUsage);
        const haikuRecords = new Map<string, Parameters<typeof saveCandidates>[0][number]>();
        for (const hit of haiku.hits) {
          const fingerprint = candidateFingerprint(unit.fingerprint, hit);
          haikuRecords.set(fingerprint, {
            fingerprint,
            unitFingerprint: unit.fingerprint,
            hit,
            source: "haiku",
          });
        }
        await saveCandidates([...haikuRecords.values()]);
        await completeUnit(unit.fingerprint, 0, 1);
        unitsProcessed++;
        await updateRun(runId, { usage: runUsage, unitsProcessed, unitsEnqueued });
      } catch (error) {
        await failUnit(unit, error);
        warnings.push(
          `${unit.repo}/${unit.path ?? unit.commitSha}: processing-fel, köad för retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Sonnet dränerar samtliga claimade kandidater i interna batcher; ingen slice(0,80).
    const totalBeforeJudge = { ...priorUsage };
    addUsage(totalBeforeJudge, runUsage);
    if (
      Date.now() < deadline &&
      estimateClaudeCost(totalBeforeJudge) < config.githubClaudeMonthlyBudgetUsd
    ) {
      // En claim motsvarar exakt en Sonnet-batch. Tidigare lyckade batcher
      // kvitteras därför även om nästa timmes batch skulle fallera.
      const candidates = await claimCandidates(Math.min(config.githubMaxCandidatesPerRun, 40));
      if (candidates.length > 0) {
        try {
          const judged = await judgeHits(
            candidates.map((candidate) => candidate.hit),
            await getProvenPatterns(),
            recordUsage,
          );
          const findings = await filterUnseenFindings(judged.findings);
          findingsNew = findings.length;
          const daytime = isDaytime();
          // Leverans först, därefter DB-kvittens. Vid DB-fel kan ett fynd
          // dubblas på retry, men det kan aldrig tyst försvinna.
          const queued = await sendAlerts(findings, daytime);
          await saveFindings(findings, queued);
          await finishCandidates(candidates.map((candidate) => candidate.fingerprint), true);
          console.log(`Sonnet: ${candidates.length} kandidater, ${findings.length} nya fynd.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await finishCandidates(candidates.map((candidate) => candidate.fingerprint), false, message);
          warnings.push(`Sonnet-batch misslyckades och återköades: ${message}`);
        }
      }
    }

    if (isDaytime()) {
      const nightFinds = await popQueuedFindings();
      const delivery = await sendMorningBrief(nightFinds);
      await clearQueuedFindings(delivery.sent);
      if (delivery.failed.length > 0) {
        warnings.push(`${delivery.failed.length} nattfynd kunde inte levereras och ligger kvar i morgonkön.`);
      }
    }

    const monthly = { ...priorUsage };
    addUsage(monthly, runUsage);
    const monthlyCost = estimateClaudeCost(monthly);
    const backlog = await getBacklogCount();
    const auditCount = await getAuditCount();
    if (monthlyCost >= 50) {
      const tier = monthlyCost >= config.githubClaudeMonthlyBudgetUsd ? "budget" : "warning";
      const month = new Date().toISOString().slice(0, 7);
      const key = `github_cost_alert_${month}_${tier}`;
      if (!(await getState(key))) {
        warnings.push(
          `Claude-kostnad denna månad: $${monthlyCost.toFixed(2)} / $${config.githubClaudeMonthlyBudgetUsd}. ` +
            `${backlog} enheter/kandidater väntar.`,
        );
        await setState(key, new Date().toISOString());
      }
    }
    if (backlog > 1000) warnings.push(`Backloggen är ${backlog}; data är sparad men alerts kan vara fördröjda.`);
    const previousAuditCount = Number((await getState("github_audit_count")) ?? 0);
    if (auditCount > previousAuditCount) {
      warnings.push(
        `${auditCount} GitHub-enheter kräver manuell audit (${auditCount - previousAuditCount} nya); de är inte markerade som lyckade.`,
      );
      await setState("github_audit_count", String(auditCount));
    }
    if (warnings.length > 0) await sendOperationalAlert(warnings.slice(0, 20).join("\n"));

    await updateRun(runId, {
      finishedAt: new Date().toISOString(),
      reposTouched: targets.length,
      unitsEnqueued,
      unitsProcessed,
      githubApiCalls: getGithubApiCallCount(),
      usage: runUsage,
      findingsNew,
      estimatedCostUsd: estimateClaudeCost(runUsage),
      backlogRemaining: backlog,
      error: warnings.length ? warnings.slice(0, 20).join("\n") : null,
    });
    await setState("last_github_run", new Date().toISOString());
    console.log(
      `Klart: ${unitsEnqueued} köade, ${unitsProcessed} processade, backlog ${backlog}, AI $${estimateClaudeCost(runUsage).toFixed(4)}.`,
    );
  } catch (error) {
    await updateRun(runId, {
      finishedAt: new Date().toISOString(),
      githubApiCalls: getGithubApiCallCount(),
      usage: runUsage,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runSelfTests(): Promise<void> {
  const baseMeta = {
    repo: "owner/repo",
    path: "examples/token.ts",
    url: "https://example.test",
    mode: "diff" as const,
    commitSha: "abc",
  };

  // En jättelång rad delas utan att ett enda tecken tappas.
  const longLine = "x".repeat(31_337);
  const longChunks = chunkText(longLine, baseMeta);
  assert.equal(longChunks.map((chunk) => chunk.text).join(""), longLine);

  // Kontext och match överlever en normal chunkgräns.
  const boundaryText = `${"a".repeat(11_900)}\ncontext\nmy coin\nmore context`;
  const boundaryChunks = chunkText(boundaryText, baseMeta);
  const boundaryHits = extractRuleHits(boundaryChunks, []);
  assert.ok(boundaryHits.some((hit) => hit.line === "my coin"));
  assert.ok(boundaryHits.some((hit) => hit.context.includes("more context")));

  // Fler än de gamla 50/80-gränserna får unika hållbara fingerprints.
  const fingerprints = new Set(
    Array.from({ length: 120 }, (_, index) =>
      unitFingerprint({
        repo: "owner/repo",
        kind: "commit",
        commitSha: `sha-${index}`,
        parentSha: `sha-${index - 1}`,
      }),
    ),
  );
  assert.equal(fingerprints.size, 120);

  const completeFile = {
    filename: "a.ts",
    previousFilename: null,
    status: "modified" as const,
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
  };
  assert.equal(patchIsComplete(completeFile), true);
  assert.equal(patchIsComplete({ ...completeFile, additions: 2 }), false);
  assert.equal(patchIsComplete({ ...completeFile, patch: null }), false);

  assert.equal(
    estimateClaudeCost({
      haikuInput: 1_000_000,
      haikuOutput: 1_000_000,
      sonnetInput: 1_000_000,
      sonnetOutput: 1_000_000,
    }),
    24,
  );
  await runScannerFixtureTests();
  console.log("github:selftest OK — chunking, context, overflow, patch-fallback och kostnad.");
}

(SELFTEST ? runSelfTests() : main())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
