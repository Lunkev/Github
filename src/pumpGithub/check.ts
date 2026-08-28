import { config } from "../config.js";

const GH_RE = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)(?:\/([\w.-]+))?/i;
const IPFS_CID_RE = /\/ipfs\/([A-Za-z0-9]+)/i;
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://pump.mypinata.cloud/ipfs/"];

export function hostnameOf(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isBlockedHost(uri: string, blocklist = config.pumpMetadataBlocklist): boolean {
  const host = hostnameOf(uri);
  if (!host) return false;
  return blocklist.some((b) => host === b || host.endsWith(`.${b}`));
}

export function extractWebsite(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const top = typeof m.website === "string" ? m.website.trim() : "";
  if (top) return top;
  const ext = m.extensions;
  if (ext && typeof ext === "object") {
    const w = (ext as Record<string, unknown>).website;
    if (typeof w === "string" && w.trim()) return w.trim();
  }
  return null;
}

export function parseGithubUrl(website: string): { owner: string; repo: string | null; url: string } | null {
  const m = website.match(GH_RE);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2] && m[2] !== owner ? m[2] : null;
  const url = repo
    ? `https://github.com/${owner}/${repo}`
    : `https://github.com/${owner}`;
  return { owner, repo, url };
}

/** IPFS CID från URI, eller null om det inte är ipfs-sökväg. */
export function ipfsCid(uri: string): string | null {
  const m = uri.match(IPFS_CID_RE);
  return m?.[1] ?? null;
}

export function gatewayUrls(cid: string): string[] {
  return GATEWAYS.map((g) => `${g}${cid}`);
}
