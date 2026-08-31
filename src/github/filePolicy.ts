export type GithubFileAction = "content" | "path_only";

export interface GithubFileDecision {
  action: GithubFileAction;
  reason?: string;
}

export const MAX_GITHUB_CONTENT_BYTES = 200_000;

const DENIED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".pnpm-store",
  "__generated__",
  "generated",
]);

const BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "avi",
  "bin",
  "bmp",
  "bz2",
  "class",
  "db",
  "dll",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "lockb",
  "mov",
  "mp3",
  "mp4",
  "o",
  "obj",
  "otf",
  "parquet",
  "pdf",
  "png",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "svg",
  "tar",
  "tflite",
  "ttf",
  "wasm",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xz",
  "zip",
  "zst",
]);

const LOCK_FILES = new Set([
  "bun.lock",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

/** Balanserad policy: behåll okänd text och all källkod, skippa säkert bulkbrus. */
export function classifyGithubFile(path: string, size = 0): GithubFileDecision {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  const filename = parts.at(-1) ?? normalized;
  const extension = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";

  const deniedDirectory = parts.slice(0, -1).find((part) => DENIED_DIRECTORIES.has(part));
  if (deniedDirectory) return { action: "path_only", reason: `directory:${deniedDirectory}` };
  if (LOCK_FILES.has(filename)) return { action: "path_only", reason: "lockfile" };
  if (BINARY_EXTENSIONS.has(extension)) return { action: "path_only", reason: `binary-extension:${extension}` };
  if (/\.(?:min|bundle)\.(?:css|js|mjs|cjs)$/.test(filename) || filename.endsWith(".map")) {
    return { action: "path_only", reason: "generated-output" };
  }
  if (
    /(?:^|[._-])generated(?:[._-]|$)/.test(filename) ||
    /\.(?:designer\.cs|g\.dart|pb\.go)$/.test(filename)
  ) {
    return { action: "path_only", reason: "generated-output" };
  }
  if (size > MAX_GITHUB_CONTENT_BYTES) {
    return { action: "path_only", reason: `size>${MAX_GITHUB_CONTENT_BYTES}` };
  }
  return { action: "content" };
}

/** Bakåtkompatibel bool för äldre anrop och enkla tester. */
export function isInterestingFile(path: string, size: number): boolean {
  return classifyGithubFile(path, size).action === "content";
}
