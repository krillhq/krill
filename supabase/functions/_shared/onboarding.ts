// The first time Krill Lab sees a repo: it mines the team's rules from its review history and
// opens the "Your team's rules" PR. Approving the rules = merging that PR.
import type { Octokit } from "octokit";
import { db } from "./db.ts";
import { commitToBranch, type FileChange, openOrUpdatePullRequest } from "./git.ts";
import { mineRepository } from "./mining.ts";
import { storeComments } from "./learning.ts";
import { kickIndexWorker, planIndex } from "./code-index.ts";
import { embeddingsEnabled } from "./embeddings.ts";
import { planAgentFileChanges } from "./agent-files.ts";
import { renderPullRequest, renderRulesFile, renderTemplateFile } from "./rules-file.ts";
import { getFile, RULES_PATH, syncRulesFile } from "./rules-sync.ts";

const RULES_BRANCH = "krill/rules";
const STALE_RUN_MS = 15 * 60 * 1000;

export async function onboardRepository(
  octokit: Octokit,
  installationId: number,
  owner: string,
  repo: string,
): Promise<string> {
  const fullName = `${owner}/${repo}`;
  const onboardingId = await claimOnboarding(installationId, fullName);
  if (onboardingId === null) return "already analyzed";

  try {
    // Code index for spotting duplicated logic: the worker builds it in batches.
    // If it fails here, it is requested again on the first review.
    if (embeddingsEnabled) await planIndex(octokit, installationId, owner, repo)
      .then(async (pending) => {
        if (pending > 0) await kickIndexWorker(fullName);
        console.log(`[index] ${fullName}: ${pending} files queued for the worker`);
      })
      .catch((err) => console.error(`[index] ${fullName} failed`, err));

    // If the team already has rules, respect them: just load them
    if (await getFile(octokit, owner, repo, RULES_PATH)) {
      await syncRulesFile(octokit, installationId, owner, repo);
      await finishOnboarding(onboardingId, { status: "skipped", detail: `already has ${RULES_PATH}` });
      return "already had rules";
    }

    const result = await mineRepository(octokit, owner, repo);
    // The analyzed history becomes context for continuous learning
    await storeComments(installationId, fullName, result.comments, true);
    const rulesFile = result.rules.length
      ? renderRulesFile(fullName, result.rules)
      : renderTemplateFile(fullName);
    const changes: FileChange[] = [{ path: RULES_PATH, content: rulesFile }];
    if (result.rules.length) {
      changes.push(...(await planAgentFileChanges(octokit, owner, repo, rulesFile)));
    }

    const { title, body } = renderPullRequest(result);
    const base = await commitToBranch(octokit, owner, repo, RULES_BRANCH, changes, title.replace(/^🦐 /, ""));
    const pr = await openOrUpdatePullRequest(octokit, owner, repo, RULES_BRANCH, base, title, body);

    await finishOnboarding(onboardingId, {
      status: "done",
      rules_proposed: result.rules.length,
      pr_number: pr.number,
      detail: `${result.humanComments} human comments`,
    });
    console.log(`[onboarding] ${fullName}: ${result.rules.length} rules → ${pr.url}`);
    return pr.url;
  } catch (err) {
    await finishOnboarding(onboardingId, { status: "failed", detail: String(err) });
    throw err;
  }
}

// One run per repo; a failed analysis can be retried
async function claimOnboarding(installationId: number, repo: string): Promise<number | null> {
  const { data, error } = await db
    .from("onboardings")
    .insert({ installation_id: installationId, repo })
    .select("id")
    .single();
  if (!error) return data.id;
  if (error.code !== "23505") throw error; // 23505 = unique_violation

  const { data: retried, error: retryError } = await db
    .from("onboardings")
    .update({ status: "running", detail: null, updated_at: new Date().toISOString() })
    .eq("repo", repo)
    // Failed, or "running" for too long: the previous run died before it could record that
    .or(`status.eq.failed,and(status.eq.running,updated_at.lt.${new Date(Date.now() - STALE_RUN_MS).toISOString()})`)
    .select("id")
    .maybeSingle();
  if (retryError) throw retryError;
  return retried?.id ?? null;
}

async function finishOnboarding(
  id: number,
  fields: { status: "done" | "skipped" | "failed"; rules_proposed?: number; pr_number?: number; detail?: string },
) {
  const { error } = await db
    .from("onboardings")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error(`Could not update onboarding ${id}`, error);
}

export async function forgetOnboarding(repo: string) {
  const { error } = await db.from("onboardings").delete().eq("repo", repo);
  if (error) throw error;
}
