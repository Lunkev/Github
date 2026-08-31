// GitHub-scannern — discovery och processing är separerade av en varaktig kö.
// En timeout eller budgetpaus kan därför skapa fördröjning men aldrig tyst bortfall.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import {
  getGithubApiCallCount,
  getHeadCommit,
  getTree,
  listCommitsAfter,
  listOrgRepos,
  permalink,
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
import { classifyGithubFile } from "./github/filePolicy.js";
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
  claimPathOnlyUnits,
  claimCandidates,
  claimUnits,
  classifyQueuedPathOnly,
  completePathOnlyUnits,
  completeUnit,
  createRun,
  enqueueUnits,
  failUnit,
  finishCandidates,
  getAuditCount,
  getBacklogMetrics,
  getMonthlyUsage,
  getRepoState,
  saveCandidates,
  saveRepoState,
  skipUnit,
  unitFingerprint,
  updateRun,
  type ScanUnit,
  type ScanUnitInput,
  type ScanLane,
  type RunStopReason,
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

/** Sprider den reserverade baseline-kapaciteten jämnt över körningen. */
export function buildLaneSchedule(total: number, fastPercent: number): ScanLane[] {
  const slots = Math.max(0, Math.floor(total));
  if (slots === 0) return [];
  if (slots === 1) return ["fast"];
  const safePercent = Math.min(95, Math.max(5, Math.round(fastPercent)));
  const fastSlots = Math.min(slots - 1, Math.max(1, Math.round((slots * safePercent) / 100)));
  const baselineSlots = slots - fastSlots;
  return Array.from({ length: slots }, (_, index) =>
    Math.floor(((index + 1) * baselineSlots) / slots) >
    Math.floor((index * baselineSlots) / slots)
      ? "baseline"
      : "fast",
  );
}

function weekKey(now = new Date()): string {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function githubFastLatencyLevel(minutes: number): "healthy" | "warning" | "critical" {
  if (minutes >= 240) return "critical";
  if (minutes >= 90) return "warning";
  return "healthy";
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
    lane: "fast",
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
    lane: parent.lane,
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

function pathOnlyChunk(unit: ScanUnit): TextChunk {
  const path = unit.path ?? "(unknown)";
  const commitUrl = typeof unit.payload?.commitUrl === "string" ? unit.payload.commitUrl : undefined;
  return {
    repo: unit.repo,
    path,
    url: commitUrl ?? permalink(refFromFull(unit.repo), path, unit.commitSha),
    mode: unit.kind === "commit_file" ? "diff" : "deep",
    commitSha: unit.commitSha,
    commitMessage:
      typeof unit.payload?.commitMessage === "string" ? unit.payload.commitMessage : undefined,
    startLine: 1,
    text: path,
  };
}

function pathOnlyRecords(
  units: ScanUnit[],
  learnedTerms: string[],
): Parameters<typeof saveCandidates>[0] {
  return units.flatMap((unit) =>
    extractRuleHits([pathOnlyChunk(unit)], learnedTerms).map((hit) => ({
      fingerprint: candidateFingerprint(unit.fingerprint, hit),
      unitFingerprint: unit.fingerprint,
      lane: unit.lane,
      hit,
      source: "rule" as const,
    })),
  );
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
  const units: ScanUnitInput[] = tree.map((file) => {
    const decision = classifyGithubFile(file.path, file.size);
    return {
      repo,
      kind: "deep_file",
      lane: "baseline",
      scanMode: decision.action,
      skipReason: decision.reason,
      commitSha: headSha,
      path: file.path,
      blobSha: file.sha,
      payload: { size: file.size },
    };
  });
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
  const initialBacklog = await getBacklogMetrics();
  const effectiveFastPercent =
    initialBacklog.oldestFastMinutes >= 90 ? 90 : config.githubFastLanePercent;
  const laneSchedule = buildLaneSchedule(config.githubMaxUnitsPerRun, effectiveFastPercent);
  const runUsage = zeroUsage();
  const priorUsage = await getMonthlyUsage();
  let unitsEnqueued = 0;
  let unitsProcessed = 0;
  let pathOnlyProcessed = 0;
  let unitSlotsUsed = 0;
  let findingsNew = 0;
  let stopReason: RunStopReason = "empty";
  const warnings = newRepos.length ? [`Nya repos i bevakade orgs: ${newRepos.join(", ")}`] : [];
  const recordUsage = async (usage: UsageTotals): Promise<void> => {
    addUsage(runUsage, usage);
    await updateRun(runId, { usage: runUsage, unitsProcessed, unitsEnqueued });
  };

  try {
    // Discovery får alltid gå före AI-drain: nya commits säkras även vid stor backlog.
    for (const repo of targets) {
      if (Date.now() >= deadline) {
        stopReason = "deadline";
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

    // Gammal baseline klassificeras och dräneras separat. Path-only gör bara
    // lokal filnamnsmatchning och kan därför köras i stora, kostnadsfria batcher.
    if (Date.now() < deadline) {
      if ((await getState("github_path_policy_v1_complete")) !== "1") {
        const classified = await classifyQueuedPathOnly(config.githubMaxPathOnlyPerRun);
        if (classified < config.githubMaxPathOnlyPerRun) {
          await setState("github_path_policy_v1_complete", "1");
        }
      }
      const pathOnlyUnits = await claimPathOnlyUnits(config.githubMaxPathOnlyPerRun);
      if (pathOnlyUnits.length > 0) {
        try {
          const records = pathOnlyRecords(pathOnlyUnits, learnedTerms);
          for (let i = 0; i < records.length; i += 500) {
            await saveCandidates(records.slice(i, i + 500));
          }
          for (let i = 0; i < pathOnlyUnits.length; i += 200) {
            const batch = pathOnlyUnits.slice(i, i + 200);
            await completePathOnlyUnits(batch.map((unit) => unit.fingerprint));
            pathOnlyProcessed += batch.length;
          }
          await updateRun(runId, { pathOnlyProcessed });
        } catch (error) {
          await updateRun(runId, { pathOnlyProcessed });
          warnings.push(
            `Path-only-batch misslyckades och återtas efter stale-lock: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // Extraktion och Haiku körs unit-för-unit. Texten blir en egen hållbar
    // chunk-unit innan AI-anropet, så stora filer kan återupptas säkert.
    while (unitSlotsUsed < config.githubMaxUnitsPerRun && Date.now() < deadline) {
      const totalUsage = { ...priorUsage };
      addUsage(totalUsage, runUsage);
      if (estimateClaudeCost(totalUsage) >= config.githubClaudeMonthlyBudgetUsd) {
        stopReason = "budget";
        break;
      }
      const preferredLane = laneSchedule[unitSlotsUsed] ?? "fast";
      const [unit] = await claimUnits(1, preferredLane);
      if (!unit) break;
      unitSlotsUsed++;
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
          if (extraction.skipReason) {
            const records = pathOnlyRecords([unit], learnedTerms);
            await saveCandidates(records);
            await skipUnit(unit.fingerprint, extraction.skipReason);
          } else if (extraction.auditReasons.length > 0) {
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
          return {
            fingerprint,
            unitFingerprint: unit.fingerprint,
            lane: unit.lane,
            hit,
            source: "rule" as const,
          };
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
            lane: unit.lane,
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
    if (stopReason === "empty") {
      if (Date.now() >= deadline) stopReason = "deadline";
      else if (unitSlotsUsed >= config.githubMaxUnitsPerRun) stopReason = "unit_cap";
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
      const candidateLimit = Math.min(config.githubMaxCandidatesPerRun, 40);
      const candidateSchedule = buildLaneSchedule(candidateLimit, effectiveFastPercent);
      const fastCandidateSlots = candidateSchedule.filter((lane) => lane === "fast").length;
      const baselineCandidateSlots = candidateLimit - fastCandidateSlots;
      const fastCandidates =
        fastCandidateSlots > 0 ? await claimCandidates(fastCandidateSlots, "fast") : [];
      const baselineCandidates =
        baselineCandidateSlots > 0 ? await claimCandidates(baselineCandidateSlots, "baseline") : [];
      const candidates = [...fastCandidates, ...baselineCandidates];
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
    const backlogMetrics = await getBacklogMetrics();
    const backlog =
      backlogMetrics.fastUnits +
      backlogMetrics.baselineUnits +
      backlogMetrics.fastCandidates +
      backlogMetrics.baselineCandidates +
      backlogMetrics.pathOnlyUnits;
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
    const previousLatencyLevel = (await getState("github_fast_latency_level")) ?? "healthy";
    const latencyLevel = githubFastLatencyLevel(backlogMetrics.oldestFastMinutes);
    if (latencyLevel !== previousLatencyLevel) {
      if (latencyLevel === "healthy" && previousLatencyLevel !== "healthy") {
        warnings.push(
          `Fast lane har återhämtats; äldsta väntetid är ${Math.round(backlogMetrics.oldestFastMinutes)} min.`,
        );
      } else if (latencyLevel !== "healthy") {
        warnings.push(
          `Fast lane är ${latencyLevel === "critical" ? "kraftigt " : ""}försenad: ` +
            `${Math.round(backlogMetrics.oldestFastMinutes)} min äldsta väntetid.`,
        );
      }
      await setState("github_fast_latency_level", latencyLevel);
    }
    const stalled =
      stopReason !== "budget" &&
      unitsProcessed === 0 &&
      pathOnlyProcessed === 0 &&
      backlogMetrics.fastUnits + backlogMetrics.baselineUnits + backlogMetrics.pathOnlyUnits > 0;
    const wasStalled = (await getState("github_queue_stalled")) === "1";
    if (stalled && !wasStalled) {
      warnings.push(`Ingen scan-enhet processades trots ${backlogMetrics.fastUnits + backlogMetrics.baselineUnits} väntande.`);
    } else if (!stalled && wasStalled) {
      warnings.push("GitHub-kön processar enheter igen efter föregående driftstopp.");
    }
    await setState("github_queue_stalled", stalled ? "1" : "0");
    const fastBacklog = backlogMetrics.fastUnits + backlogMetrics.fastCandidates;
    const previousBacklog = Number((await getState("github_previous_fast_backlog")) ?? fastBacklog);
    const previousGrowthRuns = Number((await getState("github_backlog_growth_runs")) ?? 0);
    const growthRuns = fastBacklog > previousBacklog ? previousGrowthRuns + 1 : 0;
    if (growthRuns >= 3 && previousGrowthRuns < 3) {
      warnings.push(`Fast lane har vuxit ${growthRuns} körningar i rad (${previousBacklog} → ${fastBacklog}).`);
    } else if (growthRuns === 0 && previousGrowthRuns >= 3) {
      warnings.push(`Fast lane växer inte längre; backlog är ${fastBacklog}.`);
    }
    await setState("github_previous_fast_backlog", String(fastBacklog));
    await setState("github_backlog_growth_runs", String(growthRuns));
    const previousAuditCount = Number((await getState("github_audit_count")) ?? 0);
    if (auditCount > previousAuditCount) {
      warnings.push(
        `${auditCount} GitHub-enheter kräver manuell audit (${auditCount - previousAuditCount} nya); de är inte markerade som lyckade.`,
      );
    }
    await setState("github_audit_count", String(auditCount));
    const digestKey = `github_baseline_digest_${weekKey()}`;
    if (!(await getState(digestKey))) {
      warnings.push(
        `Veckostatus: fast ${fastBacklog}; content-baseline ` +
          `${backlogMetrics.baselineUnits + backlogMetrics.baselineCandidates}; ` +
          `path-only kvar ${backlogMetrics.pathOnlyUnits}, klara/skippade ${backlogMetrics.skippedUnits}; ` +
          `äkta audits ${auditCount}.`,
      );
      await setState(digestKey, new Date().toISOString());
    }
    if (warnings.length > 0) await sendOperationalAlert(warnings.slice(0, 20).join("\n"));

    await updateRun(runId, {
      finishedAt: new Date().toISOString(),
      reposTouched: targets.length,
      unitsEnqueued,
      unitsProcessed,
      pathOnlyProcessed,
      githubApiCalls: getGithubApiCallCount(),
      usage: runUsage,
      findingsNew,
      estimatedCostUsd: estimateClaudeCost(runUsage),
      backlogRemaining: backlog,
      backlog: backlogMetrics,
      runDurationSeconds: Math.round((Date.now() - startedAt) / 1000),
      stopReason,
      error: warnings.length ? warnings.slice(0, 20).join("\n") : null,
    });
    await setState("last_github_run", new Date().toISOString());
    console.log(
      `Klart: ${unitsEnqueued} köade, ${unitsProcessed} content + ${pathOnlyProcessed} path-only processade, ` +
        `fast ${backlogMetrics.fastUnits + backlogMetrics.fastCandidates} (${Math.round(backlogMetrics.oldestFastMinutes)} min), ` +
        `baseline ${backlogMetrics.baselineUnits + backlogMetrics.baselineCandidates} (${Math.round(backlogMetrics.oldestBaselineMinutes)} min), ` +
        `path-only ${backlogMetrics.pathOnlyUnits}, ` +
        `stopp ${stopReason}, AI $${estimateClaudeCost(runUsage).toFixed(4)}.`,
    );
  } catch (error) {
    const fatalMessage = error instanceof Error ? error.message : String(error);
    const backlogMetrics = await getBacklogMetrics().catch(() => undefined);
    const backlog = backlogMetrics
      ? backlogMetrics.fastUnits +
        backlogMetrics.baselineUnits +
        backlogMetrics.fastCandidates +
        backlogMetrics.baselineCandidates +
        backlogMetrics.pathOnlyUnits
      : undefined;
    await updateRun(runId, {
      finishedAt: new Date().toISOString(),
      githubApiCalls: getGithubApiCallCount(),
      usage: runUsage,
      pathOnlyProcessed,
      backlogRemaining: backlog,
      backlog: backlogMetrics,
      runDurationSeconds: Math.round((Date.now() - startedAt) / 1000),
      stopReason: "error",
      error: fatalMessage,
    });
    await sendOperationalAlert(`Fatal körning: ${fatalMessage}`).catch(() => undefined);
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
        lane: "fast",
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

  const schedule = buildLaneSchedule(20, 80);
  assert.equal(schedule.filter((lane) => lane === "fast").length, 16);
  assert.equal(schedule.filter((lane) => lane === "baseline").length, 4);
  assert.deepEqual(
    schedule.map((lane, index) => (lane === "baseline" ? index + 1 : 0)).filter(Boolean),
    [5, 10, 15, 20],
  );

  // Claim-modellen fyller från andra lane när den föredragna är tom och
  // behåller FIFO inom respektive lane.
  const simulateClaims = (fast: number[], baseline: number[], lanes: ScanLane[]): number[] =>
    lanes.flatMap((preferred) => {
      const preferredQueue = preferred === "fast" ? fast : baseline;
      const fallbackQueue = preferred === "fast" ? baseline : fast;
      const item = preferredQueue.shift() ?? fallbackQueue.shift();
      return item === undefined ? [] : [item];
    });
  assert.deepEqual(simulateClaims([1, 2], [101, 102], ["fast", "baseline", "fast", "baseline"]), [1, 101, 2, 102]);
  assert.deepEqual(simulateClaims([], [101, 102], ["fast", "fast"]), [101, 102]);
  assert.equal(simulateClaims(Array.from({ length: 100 }, (_, index) => index), [1000, 1001, 1002, 1003], schedule).filter((item) => item >= 1000).length, 4);
  const continuousFast = Array.from({ length: 1_000 }, (_, index) => index);
  const drainingBaseline = Array.from({ length: 12 }, (_, index) => 10_000 + index);
  simulateClaims(continuousFast, drainingBaseline, [...schedule, ...schedule, ...schedule]);
  assert.equal(drainingBaseline.length, 0);
  assert.equal(buildLaneSchedule(30, 65).filter((lane) => lane === "fast").length, 20);
  assert.equal(buildLaneSchedule(30, 90).filter((lane) => lane === "fast").length, 27);
  assert.equal(githubFastLatencyLevel(89), "healthy");
  assert.equal(githubFastLatencyLevel(90), "warning");
  assert.equal(githubFastLatencyLevel(239), "warning");
  assert.equal(githubFastLatencyLevel(240), "critical");
  assert.equal(weekKey(new Date("2026-09-03T12:00:00Z")), "2026-08-31");

  const pathOnlyCases = [
    ["fixtures/fee.bin", 20],
    ["schema/app.json.zst", 20],
    ["node_modules/pkg/README.md", 20],
    ["vendor/pkg/source.ts", 20],
    ["dist/app.min.js", 20],
    ["package-lock.json", 20],
    ["src/generated/client.ts", 20],
    ["src/huge.ts", 200_001],
  ] as const;
  for (const [path, size] of pathOnlyCases) {
    assert.equal(classifyGithubFile(path, size).action, "path_only", path);
  }
  for (const path of [
    "src/main.ts",
    "docs/egg.md",
    "config/app.yaml",
    "tests/mascot.test.ts",
    "examples/token.json",
    "Dockerfile",
  ]) {
    assert.equal(classifyGithubFile(path, 20).action, "content", path);
  }

  const fastParent: ScanUnit = {
    ...commitUnit("owner/repo", {
      sha: "fast-sha",
      parentSha: "parent-sha",
      message: "fast",
      date: "2026-01-01T00:00:00Z",
      url: "https://example.test/fast",
    }),
    fingerprint: "fast-parent",
    status: "processing",
    attemptCount: 1,
  };
  const inheritedFast = chunkUnit(fastParent, { ...baseMeta, text: "fast", startLine: 1 }, 0);
  assert.equal(inheritedFast.lane, "fast");
  const inheritedBaseline = chunkUnit(
    { ...fastParent, kind: "deep_file", lane: "baseline", fingerprint: "baseline-parent" },
    { ...baseMeta, mode: "deep", text: "baseline", startLine: 1 },
    0,
  );
  assert.equal(inheritedBaseline.lane, "baseline");
  const pathUnit: ScanUnit = {
    repo: "owner/repo",
    kind: "deep_file",
    lane: "baseline",
    scanMode: "path_only",
    skipReason: "binary-extension:bin",
    commitSha: "abc",
    path: "fixtures/test-dog.bin",
    blobSha: "blob",
    payload: {},
    fingerprint: "path-parent",
    status: "processing",
    attemptCount: 1,
  };
  const pathRecords = pathOnlyRecords([pathUnit], []);
  assert.equal(pathRecords.length, 1);
  assert.equal(pathRecords[0].source, "rule");
  assert.equal(pathRecords[0].hit.line, "fixtures/test-dog.bin");

  const queueSchema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(queueSchema, /for update skip locked/i);
  assert.match(queueSchema, /locked_at < now\(\) - interval '30 minutes'/i);
  assert.match(queueSchema, /attempt_count < 8/i);
  assert.match(queueSchema, /next_attempt_at <= now\(\)/i);
  assert.match(queueSchema, /idx_github_scan_units_ready_lane_fifo/i);
  assert.match(queueSchema, /with preferred as materialized/i);
  assert.match(queueSchema, /fallback as materialized/i);
  assert.match(queueSchema, /claim_github_path_only_units/i);
  assert.match(queueSchema, /classify_github_path_only_units/i);
  assert.match(queueSchema, /idx_github_scan_units_path_only_ready/i);
  assert.match(queueSchema, /scan_mode = 'content'/i);
  assert.match(queueSchema, /'skipped'/i);
  assert.doesNotMatch(queueSchema, /delete\s+from\s+github_scan_units/i);
  const alertSource = await readFile(new URL("./github/alert.ts", import.meta.url), "utf8");
  assert.match(alertSource, /discordWebhookGithubDrift/);
  assert.doesNotMatch(alertSource.slice(alertSource.indexOf("sendOperationalAlert")), /discordWebhookMaybe/);

  await runScannerFixtureTests();
  console.log("github:selftest OK — filpolicy, path-only, adaptiva lanes, FIFO, retries och stale locks.");
}

(SELFTEST ? runSelfTests() : main())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
