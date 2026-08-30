import assert from "node:assert/strict";
import {
  getHeadCommit,
  listCommitsAfter,
  listOrgRepos,
  type CommitFile,
} from "./api.js";
import { parseHaikuResponse } from "./candidateExtractor.js";
import { commitFixture, renamedFileFixture } from "./fixtures.js";
import { batchAll } from "./judge.js";
import { extractUnit } from "./scan.js";
import { unitFingerprint, type ScanUnit } from "./unitStore.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** API-fixtures täcker paginering, retry, orphan cursor och fullfil-fallback. */
export async function runScannerFixtureTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let failHeadOnce = true;
  globalThis.fetch = (async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    if (url.pathname.endsWith("/orgs/test-org/repos")) {
      const page = Number(url.searchParams.get("page") ?? 1);
      const count = page === 1 ? 100 : page === 2 ? 21 : 0;
      return json(
        Array.from({ length: count }, (_, index) => ({
          name: `repo-${(page - 1) * 100 + index}`,
          pushed_at: "2026-01-01T00:00:00Z",
        })),
      );
    }
    if (url.pathname.endsWith("/repos/owner/repo/commits") && url.searchParams.get("per_page") === "1") {
      if (failHeadOnce) {
        failHeadOnce = false;
        return json({ message: "temporary" }, 500);
      }
      return json(commitFixture(200, 200));
    }
    if (url.pathname.endsWith("/repos/owner/repo/commits")) {
      const page = Number(url.searchParams.get("page") ?? 1);
      if (page === 1) return json(commitFixture(200, 101));
      if (page === 2) return json(commitFixture(100, 1));
      return json([]);
    }
    if (url.pathname.includes("/contents/old-name.txt")) {
      return json({
        content: Buffer.from("old mascot: Moon Badger").toString("base64"),
        encoding: "base64",
      });
    }
    if (url.pathname.includes("/contents/new-name.txt")) {
      return json({
        content: Buffer.from("new mascot: Solar Badger").toString("base64"),
        encoding: "base64",
      });
    }
    return json({ message: `unhandled fixture ${url.pathname}` }, 404);
  }) as typeof fetch;

  try {
    const repos = await listOrgRepos("test-org");
    assert.equal(repos.length, 121);

    const discovery = await listCommitsAfter({ owner: "owner", repo: "repo" }, "sha-80");
    assert.equal(discovery.cursorFound, true);
    assert.equal(discovery.commits.length, 120);
    assert.equal(discovery.commits[0].sha, "sha-81");
    assert.equal(discovery.commits.at(-1)?.sha, "sha-200");

    const orphan = await listCommitsAfter({ owner: "owner", repo: "repo" }, "orphan");
    assert.equal(orphan.cursorFound, false);
    assert.equal(orphan.commits.length, 200);

    const head = await getHeadCommit({ owner: "owner", repo: "repo" });
    assert.equal(head?.sha, "sha-200");

    const input = {
      repo: "owner/repo",
      kind: "commit_file" as const,
      lane: "fast" as const,
      commitSha: "sha-new",
      parentSha: "sha-old",
      path: renamedFileFixture.filename,
      payload: {
        file: renamedFileFixture satisfies CommitFile,
        commitMessage: "rename mascot",
      },
    };
    const unit: ScanUnit = {
      ...input,
      fingerprint: unitFingerprint(input),
      status: "processing",
      attemptCount: 1,
    };
    const fallback = await extractUnit(unit);
    assert.equal(fallback.chunks.length, 2);
    assert.ok(fallback.chunks.some((chunk) => chunk.text.includes("Moon Badger")));
    assert.ok(fallback.chunks.some((chunk) => chunk.text.includes("Solar Badger")));
    assert.equal(unit.lane, "fast");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(batchAll(Array.from({ length: 121 }, (_, index) => index), 40).length, 4);
  assert.equal(parseHaikuResponse('prefix {"candidates":[]} suffix').candidates.length, 0);
  assert.throws(() => parseHaikuResponse("not json"));
}
