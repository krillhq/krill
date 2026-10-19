// Every human review comment is stored; once several new ones pile up, look for new rules.
import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import { githubApp } from "../_shared/github.ts";
import { LEARN_THRESHOLD, learnFromReviews, pendingCount, storeComments } from "../_shared/learning.ts";
import type { ReviewComment } from "../_shared/mining.ts";

export async function handleReviewComment(payload: PullRequestReviewCommentEvent) {
  const installationId = payload.installation!.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;

  const stored = await storeComments(installationId, fullName, [payload.comment as unknown as ReviewComment], false);
  if (stored === 0) return; // bot, thread reply or trivial comment

  const pending = await pendingCount(fullName);
  console.log(`[learn] ${fullName}: ${pending}/${LEARN_THRESHOLD} new comments`);
  if (pending < LEARN_THRESHOLD) return;

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const outcome = await learnFromReviews(octokit, owner, repo);
  console.log(`[learn] ${fullName}: ${outcome}`);
}
