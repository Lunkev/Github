import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config, hasKey } from "../config.js";
import type { RawHit } from "./scan.js";

export type ScanUnitKind = "commit" | "commit_file" | "deep_file" | "text_chunk";
export type ScanUnitStatus = "pending" | "processing" | "done" | "error" | "audit";
export type ScanLane = "fast" | "baseline";
export type RunStopReason = "empty" | "unit_cap" | "deadline" | "budget" | "error";

export interface ScanUnitInput {
  repo: string;
  kind: ScanUnitKind;
  lane: ScanLane;
  commitSha: string;
  parentSha?: string | null;
  path?: string | null;
  blobSha?: string | null;
  payload?: Record<string, unknown>;
}

export interface ScanUnit extends ScanUnitInput {
  fingerprint: string;
  status: ScanUnitStatus;
  attemptCount: number;
}

export interface RepoState {
  repo: string;
  lastDiscoveredSha: string | null;
  baselineSha: string | null;
  baselineComplete: boolean;
  lastError: string | null;
}

export interface CandidateRecord {
  fingerprint: string;
  unitFingerprint: string;
  lane: ScanLane;
  hit: RawHit;
  source: "rule" | "haiku";
  attemptCount?: number;
}

export interface UsageTotals {
  haikuInput: number;
  haikuOutput: number;
  sonnetInput: number;
  sonnetOutput: number;
}

export interface RunPatch {
  finishedAt?: string;
  reposTouched?: number;
  unitsEnqueued?: number;
  unitsProcessed?: number;
  githubApiCalls?: number;
  usage?: UsageTotals;
  findingsNew?: number;
  estimatedCostUsd?: number;
  backlogRemaining?: number;
  backlog?: BacklogMetrics;
  runDurationSeconds?: number;
  stopReason?: RunStopReason;
  error?: string | null;
}

export interface BacklogMetrics {
  fastUnits: number;
  baselineUnits: number;
  fastCandidates: number;
  baselineCandidates: number;
  oldestFastMinutes: number;
  oldestBaselineMinutes: number;
}

let client: SupabaseClient | null = null;

function db(): SupabaseClient | null {
  if (!hasKey.supabase()) return null;
  if (!client) client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  return client;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function unitFingerprint(unit: ScanUnitInput): string {
  return hash(
    [unit.repo, unit.kind, unit.commitSha, unit.parentSha ?? "", unit.path ?? "", unit.blobSha ?? ""].join("|"),
  );
}

export function candidateFingerprint(unitFingerprintValue: string, hit: RawHit): string {
  return hash(
    [
      unitFingerprintValue,
      hit.repo,
      hit.path,
      hit.commitSha ?? "",
      String(hit.lineNumber),
      hit.line.toLowerCase().replace(/\s+/g, " ").trim(),
    ].join("|"),
  );
}

function mapUnit(row: Record<string, unknown>): ScanUnit {
  return {
    fingerprint: String(row.fingerprint),
    repo: String(row.repo),
    kind: row.kind as ScanUnitKind,
    lane: row.lane as ScanLane,
    commitSha: String(row.commit_sha),
    parentSha: (row.parent_sha as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    blobSha: (row.blob_sha as string | null) ?? null,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    status: row.status as ScanUnitStatus,
    attemptCount: Number(row.attempt_count ?? 0),
  };
}

function missingSchema(message: string): Error {
  return new Error(
    `${message}. Kör den uppdaterade supabase/schema.sql i Supabase SQL Editor innan skarp GitHub-scan.`,
  );
}

export async function assertQueueSchema(): Promise<void> {
  const d = db();
  if (!d) throw new Error("SUPABASE_URL och SUPABASE_SERVICE_KEY krävs för förlustfri GitHub-kö.");
  const { error } = await d.from("github_scan_units").select("fingerprint,lane").limit(1);
  if (error) throw missingSchema(error.message);
}

export async function getRepoState(repo: string): Promise<RepoState | null> {
  const d = db();
  if (!d) return null;
  const { data, error } = await d.from("github_repo_state").select("*").eq("repo", repo).maybeSingle();
  if (error) throw missingSchema(error.message);
  if (!data) return null;
  return {
    repo: data.repo,
    lastDiscoveredSha: data.last_discovered_sha,
    baselineSha: data.baseline_sha,
    baselineComplete: data.baseline_complete,
    lastError: data.last_error,
  };
}

export async function saveRepoState(
  repo: string,
  patch: Partial<Omit<RepoState, "repo">>,
): Promise<void> {
  const d = db();
  if (!d) return;
  const row: Record<string, unknown> = { repo, updated_at: new Date().toISOString() };
  if (patch.lastDiscoveredSha !== undefined) row.last_discovered_sha = patch.lastDiscoveredSha;
  if (patch.baselineSha !== undefined) row.baseline_sha = patch.baselineSha;
  if (patch.baselineComplete !== undefined) row.baseline_complete = patch.baselineComplete;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  const { error } = await d.from("github_repo_state").upsert(row, { onConflict: "repo" });
  if (error) throw missingSchema(error.message);
}

export async function enqueueUnits(units: ScanUnitInput[]): Promise<number> {
  const d = db();
  if (!d || units.length === 0) return 0;
  const rows = units.map((unit) => ({
    fingerprint: unitFingerprint(unit),
    repo: unit.repo,
    kind: unit.kind,
    commit_sha: unit.commitSha,
    parent_sha: unit.parentSha ?? null,
    path: unit.path ?? null,
    blob_sha: unit.blobSha ?? null,
    lane: unit.lane,
    payload: unit.payload ?? {},
  }));
  const { data, error } = await d
    .from("github_scan_units")
    .upsert(rows, { onConflict: "fingerprint", ignoreDuplicates: true })
    .select("fingerprint");
  if (error) throw missingSchema(error.message);
  return data?.length ?? 0;
}

export async function claimUnits(limit: number, preferredLane: ScanLane): Promise<ScanUnit[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.rpc("claim_github_scan_units", {
    p_limit: limit,
    p_preferred_lane: preferredLane,
  });
  if (error) throw missingSchema(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapUnit);
}

export async function completeUnit(
  fingerprint: string,
  githubApiCalls: number,
  chunkCount: number,
): Promise<void> {
  const { error } =
    (await db()
      ?.from("github_scan_units")
      .update({
        status: "done",
        processed_at: new Date().toISOString(),
        locked_at: null,
        last_error: null,
        github_api_calls: githubApiCalls,
        chunk_count: chunkCount,
      })
      .eq("fingerprint", fingerprint)) ?? {};
  if (error) throw new Error(`completeUnit: ${error.message}`);
}

export async function failUnit(unit: ScanUnit, errorValue: unknown): Promise<void> {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  if (unit.attemptCount >= 8) {
    await auditUnit(unit, `Permanent fel efter ${unit.attemptCount} försök: ${message}`, 0);
    return;
  }
  const delayMinutes = Math.min(360, 2 ** Math.min(unit.attemptCount, 8));
  const next = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  const { error } =
    (await db()
      ?.from("github_scan_units")
      .update({ status: "error", locked_at: null, last_error: message.slice(0, 2000), next_attempt_at: next })
      .eq("fingerprint", unit.fingerprint)) ?? {};
  if (error) console.error("failUnit:", error.message);
}

export async function auditUnit(
  unit: ScanUnit,
  reason: string,
  githubApiCalls: number,
): Promise<void> {
  const { error } =
    (await db()
      ?.from("github_scan_units")
      .update({
        status: "audit",
        locked_at: null,
        processed_at: new Date().toISOString(),
        last_error: reason.slice(0, 2000),
        github_api_calls: githubApiCalls,
      })
      .eq("fingerprint", unit.fingerprint)) ?? {};
  if (error) console.error("auditUnit:", error.message);
}

export async function saveCandidates(records: CandidateRecord[]): Promise<number> {
  const d = db();
  if (!d || records.length === 0) return 0;
  const rows = records.map((record) => ({
    fingerprint: record.fingerprint,
    unit_fingerprint: record.unitFingerprint,
    lane: record.lane,
    repo: record.hit.repo,
    path: record.hit.path,
    commit_sha: record.hit.commitSha ?? null,
    line_number: record.hit.lineNumber,
    excerpt: record.hit.line,
    context: record.hit.context,
    term: record.hit.term,
    url: record.hit.url,
    mode: record.hit.mode,
    source: record.source,
    commit_message: record.hit.commitMessage ?? null,
  }));
  const { data, error } = await d
    .from("github_candidates")
    .upsert(rows, { onConflict: "fingerprint", ignoreDuplicates: true })
    .select("fingerprint");
  if (error) throw missingSchema(error.message);
  return data?.length ?? 0;
}

export async function claimCandidates(limit: number, preferredLane: ScanLane): Promise<CandidateRecord[]> {
  const d = db();
  if (!d) return [];
  const { data, error } = await d.rpc("claim_github_candidates", {
    p_limit: limit,
    p_preferred_lane: preferredLane,
  });
  if (error) throw missingSchema(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    fingerprint: String(row.fingerprint),
    unitFingerprint: String(row.unit_fingerprint),
    lane: row.lane as ScanLane,
    source: row.source as "rule" | "haiku",
    attemptCount: Number(row.attempt_count ?? 0),
    hit: {
      repo: String(row.repo),
      path: String(row.path),
      commitSha: (row.commit_sha as string | null) ?? undefined,
      lineNumber: Number(row.line_number ?? 1),
      line: String(row.excerpt),
      context: String(row.context),
      term: String(row.term),
      url: String(row.url),
      mode: row.mode as "deep" | "diff",
      commitMessage: (row.commit_message as string | null) ?? undefined,
      candidateFingerprint: String(row.fingerprint),
    },
  }));
}

export async function finishCandidates(fingerprints: string[], success: boolean, reason?: string): Promise<void> {
  if (fingerprints.length === 0) return;
  const patch = success
    ? { status: "judged", judged_at: new Date().toISOString(), locked_at: null, last_error: null }
    : { status: "error", locked_at: null, last_error: (reason ?? "Judge failed").slice(0, 2000) };
  const { error } =
    (await db()?.from("github_candidates").update(patch).in("fingerprint", fingerprints)) ?? {};
  if (error) console.error("finishCandidates:", error.message);
}

export async function createRun(dryRun: boolean): Promise<number | null> {
  const d = db();
  if (!d) return null;
  const { data, error } = await d.from("github_scan_runs").insert({ dry_run: dryRun }).select("id").single();
  if (error) throw missingSchema(error.message);
  return Number(data.id);
}

export async function updateRun(id: number | null, patch: RunPatch): Promise<void> {
  if (id === null) return;
  const row: Record<string, unknown> = {};
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
  if (patch.reposTouched !== undefined) row.repos_touched = patch.reposTouched;
  if (patch.unitsEnqueued !== undefined) row.units_enqueued = patch.unitsEnqueued;
  if (patch.unitsProcessed !== undefined) row.units_processed = patch.unitsProcessed;
  if (patch.githubApiCalls !== undefined) row.github_api_calls = patch.githubApiCalls;
  if (patch.usage) {
    row.claude_haiku_input_tokens = patch.usage.haikuInput;
    row.claude_haiku_output_tokens = patch.usage.haikuOutput;
    row.claude_sonnet_input_tokens = patch.usage.sonnetInput;
    row.claude_sonnet_output_tokens = patch.usage.sonnetOutput;
  }
  if (patch.findingsNew !== undefined) row.findings_new = patch.findingsNew;
  if (patch.estimatedCostUsd !== undefined) row.estimated_cost_usd = patch.estimatedCostUsd;
  if (patch.backlogRemaining !== undefined) row.backlog_remaining = patch.backlogRemaining;
  if (patch.backlog) {
    row.fast_units_backlog = patch.backlog.fastUnits;
    row.baseline_units_backlog = patch.backlog.baselineUnits;
    row.fast_candidates_backlog = patch.backlog.fastCandidates;
    row.baseline_candidates_backlog = patch.backlog.baselineCandidates;
    row.oldest_fast_age_minutes = patch.backlog.oldestFastMinutes;
    row.oldest_baseline_age_minutes = patch.backlog.oldestBaselineMinutes;
  }
  if (patch.runDurationSeconds !== undefined) row.run_duration_seconds = patch.runDurationSeconds;
  if (patch.stopReason !== undefined) row.stop_reason = patch.stopReason;
  if (patch.error !== undefined) row.error = patch.error;
  const { error } = (await db()?.from("github_scan_runs").update(row).eq("id", id)) ?? {};
  if (error) console.error("github_scan_runs update:", error.message);
}

export async function getMonthlyUsage(now = new Date()): Promise<UsageTotals> {
  const d = db();
  const zero = { haikuInput: 0, haikuOutput: 0, sonnetInput: 0, sonnetOutput: 0 };
  if (!d) return zero;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await d
    .from("github_scan_runs")
    .select(
      "claude_haiku_input_tokens,claude_haiku_output_tokens,claude_sonnet_input_tokens,claude_sonnet_output_tokens",
    )
    .gte("started_at", monthStart);
  if (error) {
    console.error("getMonthlyUsage:", error.message);
    return zero;
  }
  return (data ?? []).reduce<UsageTotals>(
    (sum, row) => ({
      haikuInput: sum.haikuInput + Number(row.claude_haiku_input_tokens ?? 0),
      haikuOutput: sum.haikuOutput + Number(row.claude_haiku_output_tokens ?? 0),
      sonnetInput: sum.sonnetInput + Number(row.claude_sonnet_input_tokens ?? 0),
      sonnetOutput: sum.sonnetOutput + Number(row.claude_sonnet_output_tokens ?? 0),
    }),
    zero,
  );
}

export async function getBacklogMetrics(): Promise<BacklogMetrics> {
  const d = db();
  const zero = {
    fastUnits: 0,
    baselineUnits: 0,
    fastCandidates: 0,
    baselineCandidates: 0,
    oldestFastMinutes: 0,
    oldestBaselineMinutes: 0,
  };
  if (!d) return zero;
  const { data, error } = await d.rpc("get_github_backlog_metrics");
  if (error) throw missingSchema(error.message);
  const row = (data?.[0] ?? {}) as Record<string, unknown>;
  return {
    fastUnits: Number(row.fast_units ?? 0),
    baselineUnits: Number(row.baseline_units ?? 0),
    fastCandidates: Number(row.fast_candidates ?? 0),
    baselineCandidates: Number(row.baseline_candidates ?? 0),
    oldestFastMinutes: Number(row.oldest_fast_minutes ?? 0),
    oldestBaselineMinutes: Number(row.oldest_baseline_minutes ?? 0),
  };
}

export async function getAuditCount(): Promise<number> {
  const d = db();
  if (!d) return 0;
  const [units, candidates] = await Promise.all([
    d.from("github_scan_units").select("*", { count: "exact", head: true }).eq("status", "audit"),
    d.from("github_candidates").select("*", { count: "exact", head: true }).eq("status", "audit"),
  ]);
  return (units.count ?? 0) + (candidates.count ?? 0);
}
