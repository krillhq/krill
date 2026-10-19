// Rule-mining core, with no Deno or GitHub dependencies: used by the GitHub App (mining.ts) and the
// CLI (cli/). Step 1: the model proposes rules with citations. Step 2: an audit verifies every citation
// and compares each rule with what the team already documented (AGENTS.md, CLAUDE.md…).
import { z } from "zod";

const MIN_BODY_CHARS = 40;
const MAX_BODY_CHARS = 800;
const HUNK_CONTEXT_LINES = 6;
const MAX_DOC_CHARS = 20_000;
export const MIN_SUPPORTED_EVIDENCE = 2;

export const GUIDELINE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
];

export interface ReviewComment {
  id: number;
  created_at: string;
  body: string;
  path: string;
  diff_hunk: string;
  html_url: string;
  pull_request_url: string;
  in_reply_to_id?: number;
  user: { login: string; type: string } | null;
}

export interface GuidelineFile {
  path: string;
  content: string;
}

export interface MinedRule {
  title: string;
  rule: string;
  why: string;
  blocking: boolean;
  coverage: "documented" | "partial" | "missing";
  documentedIn: string | null;
  coverageNote: string;
  evidence: { pr: number; reviewer: string; url: string; quote: string }[];
}

export interface MiningResult {
  humanComments: number;
  guidelineFiles: string[];
  rules: MinedRule[];
  comments: ReviewComment[]; // human comments analyzed, kept for continuous learning
}

// Each environment brings its own way of calling the model with structured output
export type Ask = <T extends z.ZodType>(step: string, system: string, content: string, schema: T) => Promise<z.infer<T>>;

export const CandidateSchema = z.object({
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

const MINE_PROMPT = `You analyze a repository's code review comments to uncover the team's implicit engineering standards: what reviewers ask for again and again even though nobody wrote it down as a rule.

Each comment comes with an id (c1, c2…), the PR, the file, the last lines of the commented diff and the reviewer's text.

What to extract:
- Patterns that repeat in at least 2 different comments, ideally from different PRs.
- Each rule must be concrete, actionable and written in the imperative, specific to this project (real module names, libraries, APIs or conventions), not generic programming advice.
- A rule that a single person consistently asks for also counts: in small teams, the owner of an area sets its rules.

What to discard:
- One-off fixes for a specific bug, typos, standalone questions and thanks.
- Formatting or style that a linter or formatter already catches.

blocking says whether breaking the rule should block the merge. It is true only when breaking it causes correctness bugs, data loss or corruption, security holes or money errors. It is false for code organization, style, tests or documentation. When in doubt, false: the team can make it stricter later. Do not mention severity in why: why explains why the rule exists.

In evidence_ids, cite only the comments that ask for exactly what the rule says. Sort the rules from most to least supported.
Write title, rule and why in English, even if the comments are in another language.`;

export const AuditSchema = z.object({
  audits: z.array(
    z.object({
      rule_id: z.string(),
      supported_evidence_ids: z.array(z.string()),
      coverage: z.enum(["documented", "partial", "missing"]),
      documented_in: z.string().nullable(),
      coverage_note: z.string(),
    }),
  ),
});

const AUDIT_PROMPT = `You are a skeptical auditor. You receive rules that another analyst inferred from code review comments, each with the comments that supposedly support it, and the files where the team documents its rules.

For each rule:
1. supported_evidence_ids: keep only the comments that directly and unambiguously ask for what the rule says. Drop the ones about a different topic or that need a forced interpretation.
2. coverage: "documented" if a file already requires it in enough detail for a developer or an AI agent to follow it; "partial" if there is a related rule that is more generic or incomplete; "missing" if no file mentions it.
3. documented_in: the file that covers it, or null.
4. coverage_note: one sentence, in English, on the gap between what is documented and what reviewers ask for.

Return one audit per rule, with its rule_id.`;

// Mines rules from already-downloaded comments; bots and replies are filtered out here
export async function mineComments(
  repo: string,
  allComments: ReviewComment[],
  docs: GuidelineFile[],
  ask: Ask,
): Promise<MiningResult> {
  const comments = allComments.filter(isUseful);
  const result: MiningResult = {
    humanComments: comments.length,
    comments,
    guidelineFiles: docs.map((d) => d.path),
    rules: [],
  };
  if (comments.length < MIN_SUPPORTED_EVIDENCE) return result;

  const byId = new Map(comments.map((c, i) => [`c${i + 1}`, c]));
  const candidates = await ask(
    "mine",
    MINE_PROMPT,
    `Repository: ${repo}\n\n${[...byId].map(([id, c]) => formatComment(c, id)).join("\n\n")}`,
    CandidateSchema,
  );
  if (candidates.rules.length === 0) return result;

  const docsText = docs.length
    ? docs.map((d) => `<file path="${d.path}">\n${truncate(d.content, MAX_DOC_CHARS)}\n</file>`).join("\n\n")
    : "(the repository has no guideline files)";
  const rulesText = candidates.rules
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

  // Only rules with enough verified citations survive
  const auditById = new Map(audits.map((a) => [a.rule_id, a]));
  result.rules = candidates.rules
    .map((r, i) => {
      const audit = auditById.get(`r${i + 1}`);
      const evidence = (audit?.supported_evidence_ids ?? [])
        .filter((id) => r.evidence_ids.includes(id) && byId.has(id))
        .map((id) => byId.get(id)!);
      return {
        title: r.title,
        rule: r.rule,
        why: r.why,
        blocking: r.blocking,
        coverage: audit?.coverage ?? "missing",
        documentedIn: audit?.documented_in ?? null,
        coverageNote: audit?.coverage_note ?? "",
        evidence: evidence.map((c) => ({
          pr: prNumber(c),
          reviewer: c.user!.login,
          url: c.html_url,
          quote: oneLine(c.body, 200),
        })),
      };
    })
    .filter((r) => r.evidence.length >= MIN_SUPPORTED_EVIDENCE)
    .sort((a, b) => b.evidence.length - a.evidence.length);
  return result;
}

export function isUseful(c: ReviewComment): boolean {
  return (
    c.user !== null && c.user.type !== "Bot" && !c.in_reply_to_id && c.body.trim().length >= MIN_BODY_CHARS
  );
}

export function prNumber(c: ReviewComment): number {
  return Number(c.pull_request_url.split("/").pop());
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function formatComment(c: ReviewComment, id: string): string {
  const hunk = c.diff_hunk.split("\n").slice(-HUNK_CONTEXT_LINES).join("\n");
  return `<comment id="${id}" pr="#${prNumber(c)}" path="${c.path}" reviewer="@${c.user!.login}">
<diff>
${hunk}
</diff>
${truncate(c.body, MAX_BODY_CHARS)}
</comment>`;
}
