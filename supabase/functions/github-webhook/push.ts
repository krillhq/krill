// Push to the default branch: updates the code index with the touched files and, if .krill/rules.md
// changed, reloads the rules and proposes updating the rules block in AGENTS.md / CLAUDE.md.
import type { PushEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";
import { githubApp } from "../_shared/github.ts";
import { getFile, RULES_PATH, syncRulesFile } from "../_shared/rules-sync.ts";
import { planAgentFileChanges } from "../_shared/agent-files.ts";
import { commitToBranch, openOrUpdatePullRequest } from "../_shared/git.ts";
import { hasCodeIndex, kickIndexWorker, markPaths } from "../_shared/code-index.ts";

const SYNC_BRANCH = "krill/sync-agents";

export function isDefaultBranchPush(payload: PushEvent): boolean {
  return payload.ref === `refs/heads/${payload.repository.default_branch}` && !payload.deleted;
}

export async function handlePush(payload: PushEvent) {
  const installationId = payload.installation!.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;

  // Final state of each file after all of the push's commits
  const touched = new Map<string, "changed" | "removed">();
  for (const commit of payload.commits) {
    for (const path of [...commit.added, ...commit.modified]) touched.set(path, "changed");
    for (const path of commit.removed) touched.set(path, "removed");
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);

  // The index is created on the repo's first review; here it's only kept up to date
  if (await hasCodeIndex(fullName)) {
    const changed = [...touched].filter(([, s]) => s === "changed").map(([p]) => p);
    const removed = [...touched].filter(([, s]) => s === "removed").map(([p]) => p);
    if ((await markPaths(installationId, fullName, changed, removed)) > 0) await kickIndexWorker(fullName);
  }

  if (touched.has(RULES_PATH)) await handleRulesChange(octokit, installationId, owner, repo, payload.after);
}

async function handleRulesChange(octokit: Octokit, installationId: number, owner: string, repo: string, sha: string) {
  const result = await syncRulesFile(octokit, installationId, owner, repo, sha);
  console.log(`[push] ${owner}/${repo}@${sha.slice(0, 7)}: rules ${result}`);
  if (result !== "created" && result !== "updated") return;

  // The agent files derive from .krill/rules.md: if they're out of date, propose the change
  const rules = await getFile(octokit, owner, repo, RULES_PATH, sha);
  if (!rules) return;
  const changes = await planAgentFileChanges(octokit, owner, repo, rules.content);
  if (changes.length === 0) return;

  const title = "🦐 Sync rules into AI agent files";
  const body = `\`${RULES_PATH}\` changed on the default branch. This PR updates the rules block in ${changes.map((c) => `\`${c.path}\``).join(", ")} so AI agents work with the current rules. Only the Krill Lab managed block changes.`;
  const base = await commitToBranch(octokit, owner, repo, SYNC_BRANCH, changes, title.replace(/^🦐 /, ""));
  const pr = await openOrUpdatePullRequest(octokit, owner, repo, SYNC_BRANCH, base, title, body);
  console.log(`[push] ${owner}/${repo}: agent files out of date → ${pr.url}`);
}
