import { getRepoInfo } from "../github/api.js";

export interface GithubEnrichment {
  stars: number | null;
  createdAt: string | null;
  ageDays: number | null;
  language: string | null;
  missing: boolean;
}

export async function enrichGithub(owner: string, repo: string | null): Promise<GithubEnrichment> {
  if (!repo) {
    return { stars: null, createdAt: null, ageDays: null, language: null, missing: false };
  }
  const info = await getRepoInfo(owner, repo);
  if (!info.ok) {
    return { stars: null, createdAt: null, ageDays: null, language: null, missing: info.missing };
  }
  const created = info.createdAt ? new Date(info.createdAt) : null;
  const ageDays = created && !Number.isNaN(created.getTime())
    ? Math.max(0, Math.round((Date.now() - created.getTime()) / 86_400_000))
    : null;
  return {
    stars: info.stars,
    createdAt: info.createdAt || null,
    ageDays,
    language: info.language,
    missing: false,
  };
}
