import { config } from "../config.js";

// Tunna helpers mot GitHubs REST-API. Funkar utan token (60 anrop/h),
// med token: 5 000 anrop/h. Alla fel -> null/tomt, aldrig throw.

const BASE = "https://api.github.com";

async function gh<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "narrative-scanner",
    };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Alla publika repos i en org (för org-bevakning + "nytt repo"-förslag). */
export async function listOrgRepos(org: string): Promise<{ name: string; pushedAt: string }[]> {
  const data = await gh<{ name: string; pushed_at: string }[]>(
    `/orgs/${org}/repos?per_page=100&sort=pushed`,
  );
  return (data ?? []).map((r) => ({ name: r.name, pushedAt: r.pushed_at }));
}

export interface CommitRef {
  sha: string;
  message: string;
  date: string;
  url: string;
}

function mapCommits(
  data: { sha: string; commit: { message: string; author: { date: string } }; html_url: string }[] | null,
): CommitRef[] {
  return (data ?? []).map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    date: c.commit.author?.date ?? "",
    url: c.html_url,
  }));
}

/** Senaste commit på default-branchen (för SHA-cursor). */
export async function getHeadCommit(ref: RepoRef): Promise<CommitRef | null> {
  const data = await gh<{ sha: string; commit: { message: string; author: { date: string } }; html_url: string }[]>(
    `/repos/${ref.owner}/${ref.repo}/commits?per_page=1`,
  );
  return mapCommits(data)[0] ?? null;
}

/** Senaste N commits, nyast först. */
export async function listRecentCommits(ref: RepoRef, perPage = 50): Promise<CommitRef[]> {
  const data = await gh<{ sha: string; commit: { message: string; author: { date: string } }; html_url: string }[]>(
    `/repos/${ref.owner}/${ref.repo}/commits?per_page=${perPage}`,
  );
  return mapCommits(data);
}

/** Commits sedan ett ISO-datum. */
export async function listCommitsSince(ref: RepoRef, sinceIso: string): Promise<CommitRef[]> {
  const data = await gh<{ sha: string; commit: { message: string; author: { date: string } }; html_url: string }[]>(
    `/repos/${ref.owner}/${ref.repo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=50`,
  );
  return mapCommits(data);
}

/** Diffen för en commit: ändrade filer + patch-text. */
export async function getCommitDiff(
  ref: RepoRef,
  sha: string,
): Promise<{ filename: string; patch: string }[]> {
  const data = await gh<{ files?: { filename: string; patch?: string }[] }>(
    `/repos/${ref.owner}/${ref.repo}/commits/${sha}`,
  );
  return (data?.files ?? []).map((f) => ({ filename: f.filename, patch: f.patch ?? "" }));
}

/** Hela fil-trädet (för djupscan). */
export async function getTree(ref: RepoRef): Promise<{ path: string; size: number }[]> {
  const repo = await gh<{ default_branch: string }>(`/repos/${ref.owner}/${ref.repo}`);
  if (!repo) return [];
  const tree = await gh<{ tree: { path: string; type: string; size?: number }[] }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${repo.default_branch}?recursive=1`,
  );
  return (tree?.tree ?? [])
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
}

/** Rå filinnehåll (för djupscan av utvalda filer). */
export async function getFileContent(ref: RepoRef, path: string): Promise<string> {
  const data = await gh<{ content?: string; encoding?: string }>(
    `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path)}`,
  );
  if (!data?.content || data.encoding !== "base64") return "";
  try {
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

export function permalink(ref: RepoRef, path: string, sha?: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${sha ?? "main"}/${path}`;
}
