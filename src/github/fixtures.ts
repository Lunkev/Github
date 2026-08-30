/** Deterministiska GitHub-API-fixtures för scanner-selftest; inga nätanrop behövs. */
export function commitFixture(from: number, to: number): {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: { date: string } };
  html_url: string;
}[] {
  const commits = [];
  for (let value = from; value >= to; value--) {
    commits.push({
      sha: `sha-${value}`,
      parents: [{ sha: `sha-${value - 1}` }],
      commit: {
        message: `commit ${value}`,
        author: { date: new Date(Date.UTC(2026, 0, 1, 0, value)).toISOString() },
      },
      html_url: `https://github.test/owner/repo/commit/sha-${value}`,
    });
  }
  return commits;
}

export const renamedFileFixture = {
  filename: "new-name.txt",
  previousFilename: "old-name.txt",
  status: "renamed" as const,
  additions: 200,
  deletions: 200,
  patch: null,
};
