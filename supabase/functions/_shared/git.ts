// Krill Lab's commits and pull requests. It only writes to krill/* branches, never to the default branch.
import type { Octokit } from "octokit";

export interface FileChange {
  path: string;
  content: string;
}

// Rebuilds the branch from the default branch with a single commit: the PR always shows the desired state
export async function commitToBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  files: FileChange[],
  message: string,
): Promise<string> {
  if (!branch.startsWith("krill/")) throw new Error(`Branch not allowed: ${branch}`);

  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const base = repoData.default_branch;
  const { data: baseRef } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` });
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseRef.object.sha,
  });

  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content })),
  });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.sha,
    parents: [baseRef.object.sha],
  });

  try {
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: true });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 422 && status !== 404) throw err;
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return base;
}

export async function openOrUpdatePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string }> {
  const { data: open } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open" });
  if (open[0]) {
    await octokit.rest.pulls.update({ owner, repo, pull_number: open[0].number, title, body });
    return { number: open[0].number, url: open[0].html_url };
  }
  const { data: pr } = await octokit.rest.pulls.create({ owner, repo, head: branch, base, title, body });
  return { number: pr.number, url: pr.html_url };
}
