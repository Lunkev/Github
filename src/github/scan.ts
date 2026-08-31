import {
  getBlobText,
  getCommitDetails,
  getFileContentAt,
  permalink,
  type CommitFile,
  type RepoRef,
} from "./api.js";
import { classifyGithubFile } from "./filePolicy.js";
import { matchLexicon, type LexiconHit } from "./lexicon.js";
import type { ScanUnit, ScanUnitInput } from "./unitStore.js";

const MAX_CHUNK_CHARS = 12_000;
const CHUNK_OVERLAP_LINES = 8;

export interface RawHit extends LexiconHit {
  repo: string;
  path: string;
  url: string;
  mode: "deep" | "diff";
  commitSha?: string;
  commitMessage?: string;
  candidateFingerprint?: string;
}

export interface TextChunk {
  repo: string;
  path: string;
  url: string;
  mode: "deep" | "diff";
  commitSha?: string;
  commitMessage?: string;
  startLine: number;
  text: string;
}

export interface UnitExtraction {
  chunks: TextChunk[];
  auditReasons: string[];
  childUnits: ScanUnitInput[];
  skipReason?: string;
}

function refFromRepo(repo: string): RepoRef {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) throw new Error(`Ogiltigt repo: ${repo}`);
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) };
}

/** Radbaserad chunking med överlapp så namn vid chunkgränser inte tappas. */
export function chunkText(
  text: string,
  meta: Omit<TextChunk, "text" | "startLine">,
): TextChunk[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && (chars === 0 || chars + lines[end].length + 1 <= MAX_CHUNK_CHARS)) {
      chars += lines[end].length + 1;
      end++;
    }
    // En ensam jättelång rad delas utan att innehåll tappas.
    if (end === start + 1 && lines[start].length > MAX_CHUNK_CHARS) {
      const line = lines[start];
      for (let offset = 0; offset < line.length; offset += MAX_CHUNK_CHARS) {
        chunks.push({ ...meta, startLine: start + 1, text: line.slice(offset, offset + MAX_CHUNK_CHARS) });
      }
    } else {
      chunks.push({ ...meta, startLine: start + 1, text: lines.slice(start, end).join("\n") });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_LINES);
  }
  return chunks;
}

export function patchIsComplete(file: CommitFile): boolean {
  if (!file.patch) return false;
  let additions = 0;
  let deletions = 0;
  for (const line of file.patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return additions >= file.additions && deletions >= file.deletions;
}

async function fullFileFallback(
  ref: RepoRef,
  unit: ScanUnit,
  file: CommitFile,
  commitMessage: string,
): Promise<{ chunks: TextChunk[]; audits: string[]; skippedBinary: boolean }> {
  const chunks: TextChunk[] = [];
  const audits: string[] = [];
  let skippedBinary = false;
  const common = {
    repo: unit.repo,
    mode: "diff" as const,
    commitSha: unit.commitSha,
    commitMessage,
  };
  const beforePath = file.previousFilename ?? file.filename;

  if (file.status !== "added" && unit.parentSha) {
    const before = await getFileContentAt(ref, beforePath, unit.parentSha);
    if (before.missing) audits.push(`${beforePath}: förväntad before-version saknas`);
    else if (before.binary) skippedBinary = true;
    else {
      chunks.push(
        ...chunkText(before.text, {
          ...common,
          path: `${beforePath} (before/deleted)`,
          url: permalink(ref, beforePath, unit.parentSha),
        }),
      );
    }
  }
  if (file.status !== "removed") {
    const after = await getFileContentAt(ref, file.filename, unit.commitSha);
    if (after.missing) audits.push(`${file.filename}: förväntad after-version saknas`);
    else if (after.binary) skippedBinary = true;
    else {
      chunks.push(
        ...chunkText(after.text, {
          ...common,
          path: file.filename,
          url: permalink(ref, file.filename, unit.commitSha),
        }),
      );
    }
  }
  return { chunks, audits, skippedBinary };
}

/** Läser exakt en hållbar köenhet. Fel kastas så enheten stannar i retry-kön. */
export async function extractUnit(unit: ScanUnit): Promise<UnitExtraction> {
  if (unit.scanMode === "path_only") {
    return { chunks: [], auditReasons: [], childUnits: [], skipReason: unit.skipReason ?? "path-only policy" };
  }
  const ref = refFromRepo(unit.repo);
  if (unit.kind === "deep_file") {
    if (!unit.path || !unit.blobSha) throw new Error(`deep_file saknar path/blob_sha: ${unit.fingerprint}`);
    const blob = await getBlobText(ref, unit.blobSha);
    if (blob.binary) {
      return { chunks: [], auditReasons: [], childUnits: [], skipReason: "binary-content" };
    }
    return {
      chunks: chunkText(blob.text, {
        repo: unit.repo,
        path: unit.path,
        url: permalink(ref, unit.path, unit.commitSha),
        mode: "deep",
        commitSha: unit.commitSha,
      }),
      auditReasons: [],
      childUnits: [],
    };
  }

  if (unit.kind === "commit_file") {
    const rawFile = unit.payload?.file;
    if (!rawFile || typeof rawFile !== "object") {
      throw new Error(`commit_file saknar filmetadata: ${unit.fingerprint}`);
    }
    const file = rawFile as CommitFile;
    const commitMessage =
      typeof unit.payload?.commitMessage === "string" ? unit.payload.commitMessage : "";
    if (patchIsComplete(file)) {
      return {
        chunks: chunkText(file.patch!, {
          repo: unit.repo,
          path: file.filename,
          url: permalink(ref, file.filename, unit.commitSha),
          mode: "diff",
          commitSha: unit.commitSha,
          commitMessage,
        }),
        auditReasons: [],
        childUnits: [],
      };
    }
    const fallback = await fullFileFallback(ref, unit, file, commitMessage);
    if (fallback.chunks.length === 0 && fallback.audits.length === 0) {
      if (fallback.skippedBinary) {
        return { chunks: [], auditReasons: [], childUnits: [], skipReason: "binary-content" };
      }
      fallback.audits.push(`${file.filename}: patch saknas/trunkerad och filinnehåll var tomt`);
    }
    return { chunks: fallback.chunks, auditReasons: fallback.audits, childUnits: [] };
  }

  const details = await getCommitDetails(ref, unit.commitSha);
  const commitMessage = details.message.split("\n")[0] ?? "";
  const chunks = chunkText(details.message, {
    repo: unit.repo,
    path: "(commit message)",
    url: details.url,
    mode: "diff",
    commitSha: unit.commitSha,
    commitMessage,
  });
  const childUnits: ScanUnitInput[] = [];

  for (const file of details.files) {
    chunks.push(
      ...chunkText(
        [file.status, file.previousFilename, file.filename].filter(Boolean).join(" → "),
        {
          repo: unit.repo,
          path: "(filename)",
          url: details.url,
          mode: "diff",
          commitSha: unit.commitSha,
          commitMessage,
        },
      ),
    );
    const decision = classifyGithubFile(file.filename);
    childUnits.push({
      repo: unit.repo,
      kind: "commit_file",
      lane: unit.lane,
      scanMode: decision.action,
      skipReason: decision.reason,
      commitSha: unit.commitSha,
      parentSha: details.parentSha,
      path: file.filename,
      payload: { file, commitMessage, commitUrl: details.url },
    });
  }
  return { chunks, auditReasons: [], childUnits };
}

export function extractRuleHits(chunks: TextChunk[], extraTerms: string[]): RawHit[] {
  const hits: RawHit[] = [];
  for (const chunk of chunks) {
    for (const hit of matchLexicon(chunk.text, extraTerms)) {
      hits.push({
        ...hit,
        lineNumber: chunk.startLine + hit.lineNumber - 1,
        repo: chunk.repo,
        path: chunk.path,
        url: chunk.url,
        mode: chunk.mode,
        commitSha: chunk.commitSha,
        commitMessage: chunk.commitMessage,
      });
    }
  }
  return hits;
}
