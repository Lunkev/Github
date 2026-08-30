import { config } from "../config.js";

// GitHub-fel får inte längre förvandlas till "tomt resultat": då skulle en
// cursor kunna flyttas förbi data som aldrig lästes. Callern fångar felet per
// repo/unit och lämnar arbetet i retry-kön.

const BASE = "https://api.github.com";
const PER_PAGE = 100;
let apiCalls = 0;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "narrative-scanner",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (config.githubToken) result.Authorization = `Bearer ${config.githubToken}`;
  return result;
}

async function gh<T>(path: string, allow404 = false): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      apiCalls++;
      const res = await fetch(`${BASE}${path}`, {
        headers: headers(),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.ok) return (await res.json()) as T;
      if (allow404 && res.status === 404) return null;
      const body = (await res.text()).slice(0, 500);
      const error = new GitHubApiError(`GitHub ${res.status} för ${path}: ${body}`, res.status);
      if (res.status !== 429 && res.status !== 403 && res.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error instanceof GitHubApiError && error.status && error.status < 500 && error.status !== 429 && error.status !== 403) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new GitHubApiError(`GitHub-anrop misslyckades: ${path}`);
}

export function getGithubApiCallCount(): number {
  return apiCalls;
}

export function resetGithubApiCallCount(): void {
  apiCalls = 0;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export type RepoInfo =
  | {
      ok: true;
      stars: number;
      createdAt: string;
      pushedAt: string;
      language: string | null;
      description: string | null;
    }
  | { ok: false; missing: boolean };

/** Enskilt repo för enrich (404 = missing). */
export async function getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
  try {
    const data = await gh<{
      stargazers_count?: number;
      created_at?: string;
      pushed_at?: string;
      language?: string | null;
      description?: string | null;
    }>(`/repos/${owner}/${repo}`, true);
    if (!data) return { ok: false, missing: true };
    return {
      ok: true,
      stars: data.stargazers_count ?? 0,
      createdAt: data.created_at ?? "",
      pushedAt: data.pushed_at ?? "",
      language: data.language ?? null,
      description: data.description ?? null,
    };
  } catch {
    return { ok: false, missing: false };
  }
}

/** Alla publika repos i en org (för org-bevakning + "nytt repo"-förslag). */
export async function listOrgRepos(org: string): Promise<{ name: string; pushedAt: string }[]> {
  const repos: { name: string; pushedAt: string }[] = [];
  for (let page = 1; ; page++) {
    const data =
      (await gh<{ name: string; pushed_at: string }[]>(
        `/orgs/${encodeURIComponent(org)}/repos?per_page=${PER_PAGE}&sort=full_name&page=${page}`,
      )) ?? [];
    repos.push(...data.map((r) => ({ name: r.name, pushedAt: r.pushed_at })));
    if (data.length < PER_PAGE) return repos;
  }
}

export interface CommitRef {
  sha: string;
  parentSha: string | null;
  message: string;
  date: string;
  url: string;
}

function mapCommits(
  data:
    | {
        sha: string;
        parents?: { sha: string }[];
        commit: { message: string; author: { date: string } | null };
        html_url: string;
      }[]
    | null,
): CommitRef[] {
  return (data ?? []).map((c) => ({
    sha: c.sha,
    parentSha: c.parents?.[0]?.sha ?? null,
    message: c.commit.message,
    date: c.commit.author?.date ?? "",
    url: c.html_url,
  }));
}

/** Senaste commit på default-branchen (för SHA-cursor). */
export async function getHeadCommit(ref: RepoRef): Promise<CommitRef | null> {
  const data = await gh<
    {
      sha: string;
      parents?: { sha: string }[];
      commit: { message: string; author: { date: string } | null };
      html_url: string;
    }[]
  >(
    `/repos/${ref.owner}/${ref.repo}/commits?per_page=1`,
  );
  return mapCommits(data)[0] ?? null;
}

export interface CommitDiscovery {
  commits: CommitRef[];
  headSha: string | null;
  cursorFound: boolean;
}

/** Alla commits efter cursorn, äldst först. Paginering fortsätter tills cursorn hittas. */
export async function listCommitsAfter(ref: RepoRef, lastSha: string): Promise<CommitDiscovery> {
  const newer: CommitRef[] = [];
  let headSha: string | null = null;
  for (let page = 1; page <= 1000; page++) {
    const data = await gh<
      {
        sha: string;
        parents?: { sha: string }[];
        commit: { message: string; author: { date: string } | null };
        html_url: string;
      }[]
    >(`/repos/${ref.owner}/${ref.repo}/commits?per_page=${PER_PAGE}&page=${page}`);
    const commits = mapCommits(data);
    if (page === 1) headSha = commits[0]?.sha ?? null;
    const cursorIndex = commits.findIndex((commit) => commit.sha === lastSha);
    if (cursorIndex >= 0) {
      newer.push(...commits.slice(0, cursorIndex));
      return { commits: newer.reverse(), headSha, cursorFound: true };
    }
    newer.push(...commits);
    if (commits.length < PER_PAGE) return { commits: newer.reverse(), headSha, cursorFound: false };
  }
  throw new GitHubApiError(`Commit-historiken för ${ref.owner}/${ref.repo} översteg 100 000 commits`);
}

export interface CommitFile {
  filename: string;
  previousFilename: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface CommitDetails extends CommitRef {
  files: CommitFile[];
}

/** Hela fillistan för en commit (GitHub paginerar stora commits vid 100 filer). */
export async function getCommitDetails(ref: RepoRef, sha: string): Promise<CommitDetails> {
  type Response = {
    sha: string;
    parents?: { sha: string }[];
    commit: { message: string; author: { date: string } | null };
    html_url: string;
    files?: {
      filename: string;
      previous_filename?: string;
      status: CommitFile["status"];
      additions: number;
      deletions: number;
      patch?: string;
    }[];
  };
  let first: Response | null = null;
  const files: CommitFile[] = [];
  for (let page = 1; ; page++) {
    const data = await gh<Response>(
      `/repos/${ref.owner}/${ref.repo}/commits/${sha}?per_page=${PER_PAGE}&page=${page}`,
    );
    if (!data) throw new GitHubApiError(`Tomt commitsvar för ${ref.owner}/${ref.repo}@${sha}`);
    first ??= data;
    const pageFiles = data.files ?? [];
    files.push(
      ...pageFiles.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename ?? null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
      })),
    );
    if (files.length >= 3000) {
      throw new GitHubApiError(
        `Commit ${ref.owner}/${ref.repo}@${sha} har minst 3 000 filer; GitHub trunkerar fillistan. Enheten lämnas för audit i stället för att markeras komplett.`,
      );
    }
    if (pageFiles.length < PER_PAGE) break;
  }
  const mapped = mapCommits([first])[0];
  return { ...mapped, files };
}

export interface TreeFile {
  path: string;
  size: number;
  sha: string;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** Hela trädet; vid GitHubs recursive-trunkering traverseras katalogerna explicit. */
export async function getTree(ref: RepoRef, treeish?: string): Promise<TreeFile[]> {
  let target = treeish;
  if (!target) {
    const repo = await gh<{ default_branch: string }>(`/repos/${ref.owner}/${ref.repo}`);
    if (!repo) throw new GitHubApiError(`Repo saknas: ${ref.owner}/${ref.repo}`);
    target = repo.default_branch;
  }
  const recursive = await gh<{ tree: TreeEntry[]; truncated?: boolean }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(target)}?recursive=1`,
  );
  if (!recursive) return [];
  if (!recursive.truncated) {
    return recursive.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0, sha: entry.sha }));
  }

  const files: TreeFile[] = [];
  const queue: { sha: string; prefix: string }[] = [{ sha: target, prefix: "" }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const page = await gh<{ tree: TreeEntry[] }>(
      `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(current.sha)}`,
    );
    for (const entry of page?.tree ?? []) {
      const path = current.prefix ? `${current.prefix}/${entry.path}` : entry.path;
      if (entry.type === "blob") files.push({ path, size: entry.size ?? 0, sha: entry.sha });
      if (entry.type === "tree") queue.push({ sha: entry.sha, prefix: path });
    }
  }
  return files;
}

export interface TextBlob {
  text: string;
  binary: boolean;
  missing: boolean;
}

function decodeBlob(content: string): TextBlob {
  const buffer = Buffer.from(content.replace(/\s/g, ""), "base64");
  if (buffer.includes(0)) return { text: "", binary: true, missing: false };
  const text = buffer.toString("utf8");
  const replacementCount = [...text].filter((char) => char === "\uFFFD").length;
  return { text, binary: replacementCount > Math.max(3, text.length * 0.001), missing: false };
}

export async function getBlobText(ref: RepoRef, blobSha: string): Promise<TextBlob> {
  const data = await gh<{ content?: string; encoding?: string }>(
    `/repos/${ref.owner}/${ref.repo}/git/blobs/${encodeURIComponent(blobSha)}`,
  );
  if (!data?.content || data.encoding !== "base64") {
    throw new GitHubApiError(`Blob saknar base64-innehåll: ${ref.owner}/${ref.repo}@${blobSha}`);
  }
  return decodeBlob(data.content);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function getFileContentAt(ref: RepoRef, path: string, commitSha: string): Promise<TextBlob> {
  const data = await gh<{ content?: string; encoding?: string; sha?: string }>(
    `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(commitSha)}`,
    true,
  );
  if (!data) return { text: "", binary: false, missing: true };
  if (data.content && data.encoding === "base64") return decodeBlob(data.content);
  if (data.sha) return getBlobText(ref, data.sha);
  throw new GitHubApiError(`Kunde inte läsa ${ref.owner}/${ref.repo}/${path}@${commitSha}`);
}

export function permalink(ref: RepoRef, path: string, sha?: string): string {
  return `https://github.com/${ref.owner}/${ref.repo}/blob/${encodeURIComponent(sha ?? "main")}/${encodePath(path)}`;
}
