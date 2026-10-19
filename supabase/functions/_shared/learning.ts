// Continuous learning: stores human review comments and, every few new comments, looks for rules the
// team keeps repeating that aren't in .krill/rules.md yet. It proposes them in a PR.
import type { Octokit } from "octokit";
import { z } from "zod";
import { db } from "./db.ts";
import { ask } from "./claude.ts";
import { commitToBranch, type FileChange, openOrUpdatePullRequest } from "./git.ts";
import { planAgentFileChanges } from "./agent-files.ts";
import { isUseful, oneLine, prNumber, type ReviewComment, truncate } from "./mining.ts";
import { severityLine } from "./rules-format.ts";
import { getFile, RULES_PATH } from "./rules-sync.ts";

export const LEARN_THRESHOLD = 5; // new comments per repo that trigger an analysis
const HISTORY_LIMIT = 300;
const MAX_BODY_CHARS = 800;
const LEARN_BRANCH = "krill/learn";

interface StoredComment {
  id: number;
  pr_number: number;
  author: string;
  body: string;
  path: string;
  diff_hunk: string;
  url: string;
  learned: boolean;
}

export async function storeComments(installationId: number, repo: string, comments: ReviewComment[], learned: boolean) {
  const rows = comments.filter(isUseful).map((c) => ({
    id: c.id,
    installation_id: installationId,
    repo,
    pr_number: prNumber(c),
    author: c.user!.login,
    body: c.body,
    path: c.path,
    diff_hunk: c.diff_hunk,
    url: c.html_url,
    created_at: c.created_at,
    learned,
  }));
  if (rows.length === 0) return 0;
  const { error } = await db.from("review_comments").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

export async function pendingCount(repo: string): Promise<number> {
  const { count, error } = await db
    .from("review_comments")
    .select("id", { count: "exact", head: true })
    .eq("repo", repo)
    .eq("learned", false);
  if (error) throw error;
  return count ?? 0;
}

const ProposalSchema = z.object({
  rules: z.array(
    z.object({
      title: z.string(),
      rule: z.string(),
      why: z.string(),
      blocking: z.boolean(),
      evidence_ids: z.array(z.string()),
    }),
  ),
});

const LEARN_PROMPT = `You keep a team's engineering rules up to date. You receive its current rules and code review comments written by people; the ones marked new="true" arrived since the last analysis.

Propose only NEW rules:
- That the team asks for repeatedly: at least 2 comments support it and at least one of them is new="true".
- That aren't already covered by a current rule, not even in other words. If a comment only insists on a current rule, propose nothing for it.
- Concrete, actionable, in the imperative and specific to this project.

Discard one-off bug fixes, typos, standalone questions and anything a linter catches. If there are no new rules, return an empty list: that is the most common outcome.

blocking is true only if breaking the rule causes correctness bugs, data loss, security holes or money errors; when in doubt, false.
In evidence_ids, cite only comments that ask for exactly what the rule says. Write title, rule and why in English.`;

// Claims pending comments atomically: if two events arrive at once, only one processes them
async function claimPending(repo: string): Promise<StoredComment[]> {
  const { data, error } = await db
    .from("review_comments")
    .update({ learned: true })
    .eq("repo", repo)
    .eq("learned", false)
    .select("id, pr_number, author, body, path, diff_hunk, url, learned");
  if (error) throw error;
  return data;
}

export async function learnFromReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string> {
  const fullName = `${owner}/${repo}`;
  const fresh = await claimPending(fullName);
  if (fresh.length === 0) return "no new comments";

  // If a new-rules PR is already open, start from its version so earlier proposals are kept
  const { data: openPrs } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${LEARN_BRANCH}`, state: "open" });
  const rulesFile = await getFile(octokit, owner, repo, RULES_PATH, openPrs[0] ? LEARN_BRANCH : undefined);
  if (!rulesFile) return `no ${RULES_PATH}: the initial rules must be approved first`;

  const freshIds = new Set(fresh.map((c) => c.id));
  const { data: older, error } = await db
    .from("review_comments")
    .select("id, pr_number, author, body, path, diff_hunk, url, learned")
    .eq("repo", fullName)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  const comments = [...fresh, ...older.filter((c) => !freshIds.has(c.id))];
  const byKey = new Map(comments.map((c, i) => [`c${i + 1}`, c]));

  const { rules: proposals } = await ask(
    "learn",
    LEARN_PROMPT,
    `<current_rules>\n${rulesFile.content}\n</current_rules>\n\n<comments>\n${
      [...byKey].map(([key, c]) => formatStored(c, key, freshIds.has(c.id))).join("\n\n")
    }\n</comments>`,
    ProposalSchema,
  );

  // Enforce in code what the prompt asks: 2 valid citations, at least one of them recent
  const accepted = proposals
    .map((p) => ({ ...p, evidence: p.evidence_ids.map((id) => byKey.get(id)).filter((c) => c !== undefined) }))
    .filter((p) => p.evidence.length >= 2 && p.evidence.some((c) => freshIds.has(c.id)));
  if (accepted.length === 0) return `${fresh.length} new comments, no new rules`;

  const sections = accepted.map(
    (p) => `## ${p.title}\n\n${p.rule}\n\n${severityLine(p.blocking)}\n\nWhy: ${p.why}`,
  );
  const updatedRules = `${rulesFile.content.trimEnd()}\n\n${sections.join("\n\n")}\n`;
  const changes: FileChange[] = [
    { path: RULES_PATH, content: updatedRules },
    ...(await planAgentFileChanges(octokit, owner, repo, updatedRules)),
  ];

  const { title, body } = renderLearnPullRequest(accepted, openPrs[0]?.body ?? null);
  const base = await commitToBranch(octokit, owner, repo, LEARN_BRANCH, changes, title.replace(/^🦐 /, ""));
  const pr = await openOrUpdatePullRequest(octokit, owner, repo, LEARN_BRANCH, base, title, body);
  return `${accepted.length} new rules → ${pr.url}`;
}

function formatStored(c: StoredComment, key: string, isNew: boolean): string {
  const hunk = c.diff_hunk.split("\n").slice(-6).join("\n");
  return `<comment id="${key}" new="${isNew}" pr="#${c.pr_number}" path="${c.path}" reviewer="@${c.author}">
<diff>
${hunk}
</diff>
${truncate(c.body, MAX_BODY_CHARS)}
</comment>`;
}

type Accepted = { title: string; blocking: boolean; evidence: StoredComment[] };

// The description accumulates proposals: each analysis adds rows to the open PR's table
function renderLearnPullRequest(rules: Accepted[], previousBody: string | null) {
  const rows = rules.map((r) => {
    const links = r.evidence.slice(0, 3).map((c) => `[#${c.pr_number}](${c.url}) @${c.author}`).join("<br>");
    const quote = oneLine(r.evidence[0].body, 120).replace(/\|/g, "\\|");
    return `| ${r.blocking ? "⛔ " : ""}**${r.title.replace(/\|/g, "\\|")}** | ${links} | ${quote} |`;
  });
  const title = "🦐 New rules detected";
  if (previousBody?.includes("| --- |")) return { title, body: `${previousBody.trimEnd()}\n${rows.join("\n")}` };
  const intro = `## 🦐 New rules detected\n\nYour team keeps asking for something in reviews that isn't in \`${RULES_PATH}\` yet. If you merge, Krill Lab will check it on every pull request and AI agents will read it from their instruction files.\n\nEdit or delete anything that doesn't apply in this PR.`;
  const head = "| Rule | Asked for by | Example |\n| --- | --- | --- |";
  return { title, body: `${intro}\n\n${head}\n${rows.join("\n")}` };
}
