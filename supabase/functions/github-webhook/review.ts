// Orchestrates a PR review: diff → rules (RAG) → Claude → a review with line comments.
import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";
import { githubApp } from "../_shared/github.ts";
import { db } from "../_shared/db.ts";
import { RULES_PATH, syncRulesFile } from "../_shared/rules-sync.ts";
import { annotatePatch } from "./diff.ts";
import { loadTeamRules, retrieveRules } from "./rules.ts";
import { findExistingCode } from "./similar.ts";
import { loadHelperCatalog } from "./catalog.ts";
import { hasCodeIndex, kickIndexWorker, planIndex } from "../_shared/code-index.ts";
import { embeddingsEnabled } from "../_shared/embeddings.ts";
import { type Finding, runReview } from "./llm.ts";

const IGNORED_FILES = /(\.lock|lock\.json|\.min\.js|\.map|\.snap|\.svg|\.png|\.jpg)$/i;
const MAX_FILES = 50;

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  critical: "🔴 Critical",
  major: "🟠 Major",
  minor: "🟡 Minor",
};
const BLOCKING_LABEL = "⛔ Blocks the merge";
const SEVERITY_ORDER: Finding["severity"][] = ["critical", "major", "minor"];

// A finding blocks only if it breaks a rule the team marked as blocking
type ReviewedFinding = Finding & { blocking: boolean };

export async function reviewPullRequest(payload: PullRequestEvent) {
  const installationId = payload.installation!.id;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const fullName = payload.repository.full_name;
  const pull_number = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;

  await upsertInstallation(installationId, owner);
  const reviewId = await claimReview(installationId, fullName, pull_number, headSha);
  if (reviewId === null) {
    console.log(`PR ${fullName}#${pull_number}@${headSha.slice(0, 7)} already reviewed, skipping`);
    return;
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const checkId = await startCheck(octokit, owner, repo, headSha);

  try {
    // 1. Fetch the diff file by file (paginated: large PRs exceed 100 files)
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    const reviewable = files
      .filter((f) => f.patch && f.status !== "removed" && !IGNORED_FILES.test(f.filename))
      .slice(0, MAX_FILES)
      .map((f) => ({ path: f.filename, patch: f.patch!, ...annotatePatch(f.patch!) }));

    if (reviewable.length === 0) {
      await completeCheck(octokit, owner, repo, checkId, "success", "No code files to review", "");
      await finishReview(reviewId, { status: "done", comments_posted: 0 });
      return;
    }

    // 2. The customer's rules (RAG). Re-sync .krill/rules.md in case a push was missed.
    await syncRulesFile(octokit, installationId, owner, repo).catch((err) =>
      console.error(`Could not sync ${RULES_PATH} for ${fullName}`, err)
    );
    const rules = await retrieveRules(installationId, fullName, reviewable);
    const teamRules = await loadTeamRules(installationId, fullName);
    const blockingTitles = new Set(teamRules.filter((r) => r.blocking).map((r) => r.title));
    console.log(
      `PR ${fullName}#${pull_number}: ${reviewable.length} files, ${rules.length} chunks, ` +
        `${teamRules.length} rules (${blockingTitles.size} blocking)`,
    );

    // 3. Code in the repo that already does what the new code does. If this fails, review without it.
    const existingCode = await existingCodeFor(octokit, installationId, owner, repo, reviewable).catch((err) => {
      console.error(`Could not search for similar code in ${fullName}`, err);
      return [];
    });

    const result = await runReview({
      title: payload.pull_request.title,
      description: payload.pull_request.body,
      files: reviewable,
      rules,
      ruleTitles: teamRules.map((r) => r.title),
      existingCode,
      helperCatalog: await loadHelperCatalog(fullName).catch((err) => {
        console.error(`Could not load the helper catalog for ${fullName}`, err);
        return "";
      }),
    });
    const findings: ReviewedFinding[] = groupRepeated(result.findings).map((f) => ({
      ...f,
      blocking: f.rule !== null && blockingTitles.has(f.rule),
    }));

    // 4. GitHub rejects the whole review if a comment points at a line outside the diff
    const inline: ReviewedFinding[] = [];
    const outside: ReviewedFinding[] = [];
    for (const finding of findings) {
      const file = reviewable.find((r) => r.path === finding.path);
      (file?.commentableLines.has(finding.line) ? inline : outside).push(finding);
    }

    // 5. No noise: what Krill Lab already commented on earlier commits isn't repeated
    const previous = await previousKrillComments(octokit, owner, repo, pull_number);
    const fresh = inline.filter((f) => !previous.some((p) => sameFinding(p, f)));
    const isFirstReview = previous.length === 0;
    if (isFirstReview || fresh.length > 0) {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        commit_id: headSha,
        event: "COMMENT",
        body: isFirstReview
          ? formatSummary(result.summary, inline, outside, rules.length)
          : `🦐 **Krill Lab** · ${fresh.length} ${fresh.length === 1 ? "new finding" : "new findings"} in this commit.`,
        comments: fresh.map((f) => ({
          path: f.path,
          line: f.line,
          side: "RIGHT" as const,
          body: formatFinding(f),
        })),
      });
    }
    console.log(`PR ${fullName}#${pull_number}: ${fresh.length} new comments, ${inline.length - fresh.length} already posted`);

    // 6. The check blocks the merge only if a blocking rule is broken
    const blockers = findings.filter((f) => f.blocking).length;
    await completeCheck(
      octokit,
      owner,
      repo,
      checkId,
      blockers > 0 ? "failure" : "success",
      checkTitle(blockers, findings.length),
      `${result.summary}\n\nThe details are in the comments on the **Files changed** tab.`,
    );

    await finishReview(reviewId, { status: "done", comments_posted: fresh.length });
  } catch (err) {
    // If Krill Lab fails, the check is neutral: our errors never block a customer's merge
    await completeCheck(
      octokit,
      owner,
      repo,
      checkId,
      "neutral",
      "Krill Lab could not complete the review",
      "The review failed because of an internal error. This check doesn't block the merge.",
    );
    await finishReview(reviewId, { status: "failed", error: String(err) });
    throw err;
  }
}

// Repos installed before the index existed get indexed on their first review
async function existingCodeFor(
  octokit: Octokit,
  installationId: number,
  owner: string,
  repo: string,
  files: { path: string; patch: string }[],
) {
  const fullName = `${owner}/${repo}`;
  if (!embeddingsEnabled) return [];
  // The review doesn't wait for the index: if the repo has none yet, it's requested and this review goes on without it
  if (!(await hasCodeIndex(fullName))) {
    const pending = await planIndex(octokit, installationId, owner, repo);
    if (pending > 0) await kickIndexWorker(fullName);
    console.log(`[index] ${fullName}: no index yet, ${pending} files queued for the worker`);
    return [];
  }
  const found = await findExistingCode(fullName, files);
  console.log(
    `[index] ${fullName}: ${found.length} existing-code candidates` +
      (found.length ? ` (${found.map((c) => `${c.path}:${c.startLine} ${c.similarity.toFixed(2)}`).join(", ")})` : ""),
  );
  return found;
}

const CHECK_NAME = "Krill Lab";
const SAME_FINDING_LINE_DISTANCE = 3;

interface PostedComment {
  path: string;
  line: number;
  body: string;
}

let botLogin: string | undefined;

// Krill Lab comments that are still current (ones outdated by code changes have line = null)
async function previousKrillComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<PostedComment[]> {
  if (!botLogin) {
    const { data: app } = await githubApp.octokit.rest.apps.getAuthenticated();
    botLogin = `${app!.slug}[bot]`;
  }
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return comments
    .filter((c) => c.user?.login === botLogin && c.line != null)
    .map((c) => ({ path: c.path, line: c.line!, body: c.body }));
}

// Same file, nearby lines, and the same severity or the same cited rule.
// Claude words things differently on every run, so only the start of the rule is compared.
function sameFinding(posted: PostedComment, finding: ReviewedFinding): boolean {
  if (posted.path !== finding.path) return false;
  if (Math.abs(posted.line - finding.line) > SAME_FINDING_LINE_DISTANCE) return false;
  const header = posted.body.split("\n")[0];
  const sameSeverity = header.includes(SEVERITY_LABEL[finding.severity]);
  const ruleStart = finding.rule?.slice(0, 20).toLowerCase();
  const sameRule = !!ruleStart && header.toLowerCase().includes(ruleStart);
  return sameSeverity || sameRule;
}

// Returns null if the App doesn't have the checks permission yet: the review goes on without a check
async function startCheck(octokit: Octokit, owner: string, repo: string, headSha: string) {
  try {
    const { data } = await octokit.rest.checks.create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      output: { title: "Reviewing architecture…", summary: "Krill Lab is reviewing this commit." },
    });
    return data.id;
  } catch (err) {
    console.error("Could not create the check (is the Checks: write permission missing?)", err);
    return null;
  }
}

async function completeCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkId: number | null,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string,
) {
  if (checkId === null) return;
  try {
    await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkId,
      status: "completed",
      conclusion,
      output: { title, summary: summary || title },
    });
  } catch (err) {
    console.error(`Could not complete check ${checkId}`, err);
  }
}

function checkTitle(blockers: number, total: number): string {
  if (blockers > 0) {
    return `${blockers} blocking rule ${blockers === 1 ? "violation" : "violations"}: merge blocked`;
  }
  if (total > 0) return `No blocking rules broken · ${total} ${total === 1 ? "note" : "notes"}`;
  return "No findings";
}

// A rule broken several times in the same file = one comment that lists the other lines
function groupRepeated(findings: Finding[]): Finding[] {
  const result: Finding[] = [];
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.rule === null) {
      result.push(f);
      continue;
    }
    const key = `${f.path}|${f.rule}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    const [first, ...rest] = group.sort((a, b) => a.line - b.line);
    if (rest.length === 0) {
      result.push(first);
      continue;
    }
    const severity = SEVERITY_ORDER.find((s) => group.some((f) => f.severity === s))!;
    const where = `${rest.length === 1 ? "line" : "lines"} ${rest.map((f) => f.line).join(", ")}`;
    result.push({ ...first, severity, body: `${first.body}\n\nAlso on ${where}.` });
  }
  return result;
}

async function upsertInstallation(id: number, accountLogin: string) {
  const { error } = await db.from("installations").upsert({ id, account_login: accountLogin });
  if (error) throw error;
}

// Records the review of this commit. Returns null if it already exists (unless it failed before).
async function claimReview(
  installationId: number,
  repo: string,
  pullNumber: number,
  headSha: string,
): Promise<number | null> {
  const { data, error } = await db
    .from("reviews")
    .insert({ installation_id: installationId, repo, pull_number: pullNumber, head_sha: headSha })
    .select("id")
    .single();
  if (!error) return data.id;
  if (error.code !== "23505") throw error; // 23505 = unique_violation

  const { data: retried, error: retryError } = await db
    .from("reviews")
    .update({ status: "running", error: null })
    .match({ repo, pull_number: pullNumber, head_sha: headSha, status: "failed" })
    .select("id")
    .maybeSingle();
  if (retryError) throw retryError;
  return retried?.id ?? null;
}

async function finishReview(
  id: number,
  fields: { status: "done" | "failed"; comments_posted?: number; error?: string },
) {
  const { error } = await db.from("reviews").update(fields).eq("id", id);
  if (error) console.error(`Could not update review ${id}`, error);
}

function formatFinding(f: ReviewedFinding): string {
  const rule = f.rule ? ` · Rule: _${f.rule}_` : "";
  return `**${f.blocking ? BLOCKING_LABEL : SEVERITY_LABEL[f.severity]}**${rule}\n\n${f.body}`;
}

function formatSummary(
  summary: string,
  inline: ReviewedFinding[],
  outside: ReviewedFinding[],
  ruleCount: number,
) {
  const all = [...inline, ...outside];
  const blockers = all.filter((f) => f.blocking).length;
  const counts = SEVERITY_ORDER
    .map((s) => [SEVERITY_LABEL[s], all.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}: ${n}`)
    .join(" · ");

  const parts = [`## 🦐 Krill Lab\n\n${summary}`];
  if (blockers > 0) {
    parts.push(`**${BLOCKING_LABEL}:** ${blockers} blocking rule ${blockers === 1 ? "violation" : "violations"}.`);
  }
  if (counts) parts.push(counts);
  if (outside.length > 0) {
    parts.push(
      "**Findings outside the diff lines:**\n" +
        outside.map((f) => `- \`${f.path}:${f.line}\` ${formatFinding(f).replace(/\n+/g, " ")}`).join("\n"),
    );
  }
  if (ruleCount === 0) {
    parts.push("> ⚠️ This repository has no architecture rules loaded; general principles were applied.");
  }
  return parts.join("\n\n");
}
