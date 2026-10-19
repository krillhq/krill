// Copies the rules from .krill/rules.md into the files AI agents read (AGENTS.md, CLAUDE.md…)
// in the GitHub repo. The block itself is built in agent-block.ts.
import type { Octokit } from "octokit";
import type { FileChange } from "./git.ts";
import { getFile } from "./rules-sync.ts";
import { AGENT_FILES, buildBlock, DEFAULT_AGENT_FILE, upsertBlock } from "./agent-block.ts";

export { buildBlock, upsertBlock } from "./agent-block.ts";

// Returns only the files that change; if the repo has none of them, creates AGENTS.md
export async function planAgentFileChanges(
  octokit: Octokit,
  owner: string,
  repo: string,
  rulesMarkdown: string,
): Promise<FileChange[]> {
  const block = buildBlock(rulesMarkdown);
  const changes: FileChange[] = [];
  let found = 0;
  for (const path of AGENT_FILES) {
    const file = await getFile(octokit, owner, repo, path);
    if (!file) continue;
    found++;
    const updated = upsertBlock(file.content, block);
    if (updated !== file.content) changes.push({ path, content: updated });
  }
  if (found === 0) changes.push({ path: DEFAULT_AGENT_FILE, content: `${block}\n` });
  return changes;
}
