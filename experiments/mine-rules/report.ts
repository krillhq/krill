// "Unwritten rules" report for a repo: what reviewers keep asking for that isn't documented.
//
// Usage: npx tsx report.ts <owner/repo>
// Writes reports/<repo>.json (data for the HTML page) and reports/<repo>.md (quick read).
import fs from "node:fs";
import { z } from "zod";
import { fetchComments, fetchInstructionFiles, type ReviewComment } from "./lib/github.ts";
import { ask, usage } from "./lib/claude.ts";

const MIN_BODY_CHARS = 40;
const MAX_BODY_CHARS = 800;
const HUNK_CONTEXT_LINES = 6;
const MAX_DOC_CHARS = 20_000;
const MIN_SUPPORTED_EVIDENCE = 2;

// ── Step 1: extract candidate rules ──────────────────────────────────────────

const CandidateSchema = z.object({
  rules: z.array(
    z.object({
      title: z.string(),
      rule: z.string(),
      why: z.string(),
      category: z.enum([
        "architecture",
        "api_design",
        "performance",
        "security",
        "testing",
        "compatibility",
        "maintainability",
        "i18n",
        "documentation",
      ]),
      checkable_in_diff: z.boolean(),
      evidence_ids: z.array(z.string()),
    }),
  ),
});

const MINE_PROMPT = `You analyze a repository's code review comments to uncover the team's implicit engineering standards: what reviewers ask for again and again even though nobody wrote it down as a rule.

Each comment comes with an id (c1, c2…), the PR, the file, the last lines of the commented diff and the reviewer's text.

What to extract:
- Patterns that repeat in at least 2 different comments, ideally from different PRs.
- Each rule must be concrete, actionable and written in the imperative, specific to this project (real module names, libraries, APIs or conventions), not generic programming advice.
- A rule that a single person consistently asks for also counts: in small teams, the owner of an area sets its rules.

What to discard:
- One-off fixes for a specific bug, typos, standalone questions and thanks.
- Formatting or style that a linter or formatter already catches.

checkable_in_diff is true if a reviewer could check the rule by looking only at the diff, and false if it depends on the process (tickets, release notes, how the PR is organized).

In evidence_ids, cite only the comments that ask for exactly what the rule says. Sort the rules from most to least supported. Write title, rule and why in English.`;

// ── Step 2: audit (verify citations and compare with what's documented) ──────

const AuditSchema = z.object({
  audits: z.array(
    z.object({
      rule_id: z.string(),
      supported_evidence_ids: z.array(z.string()),
      coverage: z.enum(["documented", "partial", "missing"]),
      documented_in: z.string().nullable(),
      documented_quote: z.string().nullable(),
      coverage_note: z.string(),
    }),
  ),
});

const AUDIT_PROMPT = `You are a skeptical auditor. You receive rules that another analyst inferred from code review comments, each with the comments that supposedly support it, and the files where the team documents its rules (AGENTS.md, CLAUDE.md, .cursorrules, CONTRIBUTING.md…).

For each rule:
1. supported_evidence_ids: keep only the comments that directly and unambiguously ask for what the rule says. Drop the ones about a different topic, only tangentially related, or that need a forced interpretation.
2. coverage: compare the rule with the documented files.
   - "documented": a file already requires this in enough detail for a developer or an AI agent to follow it.
   - "partial": there is a related rule, but it is more generic or incomplete (for example, the file says "use <Trans>" and the rule requires how to handle plurals inside it).
   - "missing": no file mentions it.
3. documented_in and documented_quote: the file and a short verbatim quote that covers it, or null if "missing".
4. coverage_note: one sentence, in English, explaining the gap between what is documented and what reviewers ask for.

Return one audit per rule, with its rule_id.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isUseful(c: ReviewComment): boolean {
  return c.user.type !== "Bot" && !c.in_reply_to_id && c.body.trim().length >= MIN_BODY_CHARS;
}

export function prNumber(c: ReviewComment): number {
  return Number(c.pull_request_url.split("/").pop());
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function formatComment(c: ReviewComment, id: string): string {
  const hunk = c.diff_hunk.split("\n").slice(-HUNK_CONTEXT_LINES).join("\n");
  return `<comment id="${id}" pr="#${prNumber(c)}" path="${c.path}" reviewer="@${c.user.login}">
<diff>
${hunk}
</diff>
${truncate(c.body, MAX_BODY_CHARS)}
</comment>`;
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

async function main() {
  const repo = process.argv[2];
  if (!repo?.includes("/")) throw new Error("Usage: npx tsx report.ts <owner/repo>");

  const all = fetchComments(repo);
  const docs = fetchInstructionFiles(repo);
  const comments = all.filter(isUseful);
  const dates = all.map((c) => c.created_at).sort();
  console.log(
    `${repo}: ${all.length} comments → ${comments.length} useful human comments · ` +
      `docs: ${docs.map((d) => d.path).join(", ") || "none"}`,
  );

  const { candidates, rules } = await mineRules(repo, comments, docs);

  const report = {
    repo,
    generated_at: new Date().toISOString(),
    period: { from: dates[0], to: dates.at(-1) },
    stats: {
      total_comments: all.length,
      human_comments: comments.length,
      bot_comments: countBy(
        all.filter((c) => c.user.type === "Bot"),
        (c) => c.user.login,
      ),
      prs_reviewed: new Set(comments.map(prNumber)).size,
      reviewers: countBy(comments, (c) => c.user.login),
    },
    documented_files: docs.map((d) => d.path),
    rules,
    dropped_candidates: candidates.length - rules.length,
    cost: { ...usage },
  };

  fs.mkdirSync("reports", { recursive: true });
  const base = `reports/${repo.split("/")[1]}`;
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, renderMarkdown(report));

  const missing = rules.filter((r) => r.coverage !== "documented").length;
  console.log(
    `${candidates.length} candidates → ${rules.length} verified (${missing} missing or partial) · ` +
      `total cost ≈ $${usage.usd.toFixed(2)} → ${base}.json`,
  );
}

// Extracts candidate rules, audits them against the docs and keeps the ones with verified citations
export async function mineRules(repo: string, comments: ReviewComment[], docs: { path: string; content: string }[]) {
  const byId = new Map(comments.map((c, i) => [`c${i + 1}`, c]));

  // 1. Extract
  const { rules: candidates } = await ask(
    "extract",
    MINE_PROMPT,
    `Repository: ${repo}\n\n${[...byId].map(([id, c]) => formatComment(c, id)).join("\n\n")}`,
    CandidateSchema,
  );

  // 2. Audit
  const docsText = docs.length
    ? docs.map((d) => `<file path="${d.path}">\n${truncate(d.content, MAX_DOC_CHARS)}\n</file>`).join("\n\n")
    : "(the repository has no guideline files)";
  const rulesText = candidates
    .map((r, i) => {
      const evidence = r.evidence_ids
        .filter((id) => byId.has(id))
        .map((id) => formatComment(byId.get(id)!, id))
        .join("\n");
      return `<rule id="r${i + 1}">\n${r.title}: ${r.rule}\n<evidence>\n${evidence}\n</evidence>\n</rule>`;
    })
    .join("\n\n");
  const { audits } = await ask(
    "audit",
    AUDIT_PROMPT,
    `<documented_files>\n${docsText}\n</documented_files>\n\n<rules>\n${rulesText}\n</rules>`,
    AuditSchema,
  );

  // 3. Combine: only rules with enough verified citations survive
  const auditById = new Map(audits.map((a) => [a.rule_id, a]));
  const rules = candidates
    .map((r, i) => {
      const audit = auditById.get(`r${i + 1}`);
      const evidence = (audit?.supported_evidence_ids ?? [])
        .filter((id) => r.evidence_ids.includes(id) && byId.has(id))
        .map((id) => byId.get(id)!);
      return {
        title: r.title,
        rule: r.rule,
        why: r.why,
        category: r.category,
        checkable_in_diff: r.checkable_in_diff,
        coverage: audit?.coverage ?? "missing",
        documented_in: audit?.documented_in ?? null,
        documented_quote: audit?.documented_quote ?? null,
        coverage_note: audit?.coverage_note ?? "",
        prs: new Set(evidence.map(prNumber)).size,
        reviewers: countBy(evidence, (c) => c.user.login),
        evidence: evidence.map((c) => ({
          pr: prNumber(c),
          reviewer: c.user.login,
          path: c.path,
          url: c.html_url,
          quote: oneLine(c.body, 280),
        })),
      };
    })
    .filter((r) => r.evidence.length >= MIN_SUPPORTED_EVIDENCE)
    .sort((a, b) => b.evidence.length - a.evidence.length);

  return { candidates, rules };
}

type Report = {
  repo: string;
  documented_files: string[];
  stats: { human_comments: number };
  rules: {
    title: string;
    rule: string;
    coverage: string;
    coverage_note: string;
    documented_in: string | null;
    prs: number;
    reviewers: Record<string, number>;
    evidence: { pr: number; reviewer: string; url: string; quote: string }[];
  }[];
};

function renderMarkdown(report: Report): string {
  const icon = { missing: "❌", partial: "⚠️", documented: "✅" } as Record<string, string>;
  const rules = report.rules.map(
    (r, i) => `## ${i + 1}. ${icon[r.coverage]} ${r.title}

${r.rule}

_${r.coverage}${r.documented_in ? ` (${r.documented_in})` : ""} · ${r.coverage_note}_
_${r.evidence.length} comments · ${r.prs} PRs · ${Object.entries(r.reviewers).map(([u, n]) => `@${u} (${n})`).join(", ")}_

${r.evidence.map((e) => `- [PR #${e.pr} · @${e.reviewer}](${e.url}): "${e.quote}"`).join("\n")}`,
  );
  return `# ${report.repo}

${report.stats.human_comments} human comments · docs: ${report.documented_files.join(", ") || "none"}

${rules.join("\n\n")}
`;
}

// Only runs when invoked directly, not when imported by the evaluation
if (process.argv[1]?.replaceAll("\\", "/").endsWith("report.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
