// Mines a team's implicit rules from its code review history (GitHub App version).
// The logic lives in mining-core.ts, shared with the CLI; this file only downloads the data with Octokit.
import type { Octokit } from "octokit";
import { ask } from "./claude.ts";
import { getFile } from "./rules-sync.ts";
import { GUIDELINE_FILES, type GuidelineFile, mineComments, type MiningResult, type ReviewComment } from "./mining-core.ts";

export {
  GUIDELINE_FILES,
  isUseful,
  type MinedRule,
  type MiningResult,
  oneLine,
  prNumber,
  type ReviewComment,
  truncate,
} from "./mining-core.ts";

const MAX_COMMENTS = 1000;

export async function mineRepository(octokit: Octokit, owner: string, repo: string): Promise<MiningResult> {
  const comments = await fetchReviewComments(octokit, owner, repo);
  const docs = await fetchGuidelines(octokit, owner, repo);
  return mineComments(`${owner}/${repo}`, comments, docs, ask);
}

async function fetchReviewComments(octokit: Octokit, owner: string, repo: string): Promise<ReviewComment[]> {
  let collected = 0;
  return await octokit.paginate(
    octokit.rest.pulls.listReviewCommentsForRepo,
    { owner, repo, sort: "created", direction: "desc", per_page: 100 },
    (response, done) => {
      collected += response.data.length;
      if (collected >= MAX_COMMENTS) done();
      return response.data as ReviewComment[];
    },
  );
}

async function fetchGuidelines(octokit: Octokit, owner: string, repo: string): Promise<GuidelineFile[]> {
  const docs: GuidelineFile[] = [];
  for (const path of GUIDELINE_FILES) {
    const file = await getFile(octokit, owner, repo, path);
    if (file) docs.push({ path, content: file.content });
  }
  return docs;
}
