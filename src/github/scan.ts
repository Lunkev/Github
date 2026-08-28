import { getTree, getFileContent, listCommitsSince, getCommitDiff, permalink, type RepoRef } from "./api.js";
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

/** Diff-vakt: bara det som ändrats sedan senaste körningen. */
export async function diffScan(ref: RepoRef, sinceIso: string, extraTerms: string[]): Promise<RawHit[]> {
  const commits = await listCommitsSince(ref, sinceIso);
  const hits: RawHit[] = [];
  for (const commit of commits.slice(0, 20)) {
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
  return hits;
}
