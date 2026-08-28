import {
  getTree,
  getFileContent,
  listCommitsSince,
  listRecentCommits,
  getCommitDiff,
  permalink,
  type RepoRef,
  type CommitRef,
} from "./api.js";
import { matchLexicon, isInterestingFile, type LexiconHit } from "./lexicon.js";

// Producerar RÅTRÄFFAR (lexikon-matchningar med kontext) — bedömningen sker i judge.ts.

export interface RawHit extends LexiconHit {
  repo: string; // "owner/repo"
  path: string;
  url: string; // permalänk för screenshot/bevis
  mode: "deep" | "diff";
  commitMessage?: string;
}

/** Djupscan: läser igenom hela repots intressanta filer en gång (när repot läggs till). */
export async function deepScan(ref: RepoRef, extraTerms: string[]): Promise<RawHit[]> {
  const tree = await getTree(ref);
  const files = tree.filter((f) => isInterestingFile(f.path, f.size)).slice(0, 300);
  const hits: RawHit[] = [];
  for (const file of files) {
    const content = await getFileContent(ref, file.path);
    if (!content) continue;
    for (const h of matchLexicon(content, extraTerms)) {
      hits.push({
        ...h,
        repo: `${ref.owner}/${ref.repo}`,
        path: file.path,
        url: permalink(ref, file.path),
        mode: "deep",
      });
    }
  }
  return hits;
}

/** Commits nyare än lastSha (lastSha själv hoppas över). Nyast först. */
function commitsNewerThan(commits: CommitRef[], lastSha: string | null): CommitRef[] {
  if (!lastSha) return commits;
  const idx = commits.findIndex((c) => c.sha === lastSha);
  if (idx === -1) return commits;
  return commits.slice(0, idx);
}

export interface DiffScanResult {
  hits: RawHit[];
  headSha: string | null;
}

/** Diff-vakt: bara commits nyare än lastSha (fallback: senaste 24h). */
export async function diffScan(
  ref: RepoRef,
  extraTerms: string[],
  lastSha: string | null,
): Promise<DiffScanResult> {
  const recent = lastSha
    ? await listRecentCommits(ref, 50)
    : await listCommitsSince(ref, new Date(Date.now() - 24 * 3600_000).toISOString());
  const headSha = recent[0]?.sha ?? lastSha;
  const commits = commitsNewerThan(recent, lastSha).slice(0, 20);
  const hits: RawHit[] = [];
  for (const commit of commits) {
    // commit-meddelandet i sig kan innehålla guld
    for (const h of matchLexicon(commit.message, extraTerms)) {
      hits.push({
        ...h,
        repo: `${ref.owner}/${ref.repo}`,
        path: "(commit message)",
        url: commit.url,
        mode: "diff",
        commitMessage: commit.message.split("\n")[0],
      });
    }
    const files = await getCommitDiff(ref, commit.sha);
    for (const file of files) {
      if (!file.patch) continue;
      // bara TILLAGDA rader (+) är intressanta i en diff
      const added = file.patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
      for (const h of matchLexicon(added, extraTerms)) {
        hits.push({
          ...h,
          repo: `${ref.owner}/${ref.repo}`,
          path: file.filename,
          url: permalink(ref, file.filename, commit.sha),
          mode: "diff",
          commitMessage: commit.message.split("\n")[0],
        });
      }
    }
  }
  return { hits, headSha };
}
