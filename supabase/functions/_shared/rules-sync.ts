// Syncs a repo's .krill/rules.md into pgvector. The file in the repo is the source of truth.
// The special "<owner>/.github" repo defines rules for the whole organization.
import type { Octokit } from "octokit";
import { deleteRuleDocument, findFileDocument, saveRuleDocument } from "./rules-store.ts";
import { RULES_PATH } from "./rules-format.ts";

export { RULES_PATH };
const ORG_RULES_REPO = ".github";

export type SyncResult = "created" | "updated" | "unchanged" | "deleted" | "absent";

export async function syncRulesFile(
  octokit: Octokit,
  installationId: number,
  owner: string,
  repo: string,
  ref?: string,
): Promise<SyncResult> {
  const scope = repo === ORG_RULES_REPO ? null : `${owner}/${repo}`;
  const existing = await findFileDocument(installationId, scope, RULES_PATH);

  const file = await getFile(octokit, owner, repo, RULES_PATH, ref);
  if (!file) {
    if (!existing) return "absent";
    await deleteRuleDocument(existing.id);
    return "deleted";
  }
  if (existing?.sha === file.sha) return "unchanged";

  await saveRuleDocument({
    installationId,
    repo: scope,
    title: scope ? `Rules for ${scope}` : `Rules for the ${owner} organization`,
    content: file.content,
    source: "file",
    path: RULES_PATH,
    sha: file.sha,
  });
  return existing ? "updated" : "created";
}

export async function getFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") return null;
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
    return { content: new TextDecoder().decode(bytes), sha: data.sha };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
