// Evaluation: does Krill Lab anticipate what human reviewers ask for better than "Claude + the team's AGENTS.md"?
//
// 1. Rules are learned only from reviews BEFORE the first test PR.
// 2. Each test PR is reviewed at the commit the humans saw, with the same model and prompt:
//      A (baseline):   the repo's guideline files (AGENTS.md, CLAUDE.md…)
//      B:              A + the learned rules
//      C (Krill Lab):  B + repo context (similar code and a helper catalog), indexed at the cutoff date
// 3. A judge compares each review with that PR's human comments.
//
// Uso: npx tsx eval.ts <owner/repo> [--prs 15] [--pages 20] [--fresh-rules]
import fs from "node:fs";
import { z } from "zod";
import { fetchComments, fetchInstructionFiles, gh, type ReviewComment } from "./lib/github.ts";
import { ask, MODEL, usage } from "./lib/claude.ts";
import { buildIndex, commitAt, type CodeIndex, embedMany, helperCatalog, nearest } from "./lib/code-context.ts";
import { addedBlocks, changedOldRanges } from "../../supabase/functions/github-webhook/diff.ts";
import { chunkCode } from "../../supabase/functions/_shared/code-chunk.ts";
import { isUseful, mineRules, prNumber } from "./report.ts";

const IGNORED_FILES = /(\.lock|lock\.json|lock\.yaml|\.min\.js|\.map|\.snap|\.svg|\.png|\.jpg|\.gif|\.webp)$/i;
const MAX_DIFF_CHARS = 60_000; // larger PRs are skipped: they don't fit comfortably in one review
const MAX_DOC_CHARS = 20_000;
const MIN_HUMAN_COMMENTS = 2;
const MIN_SIMILARITY = 0.8;
const MAX_EXISTING = 6;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

// ── Diff of the commit the humans reviewed ───────────────────────────────────

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function annotatePatch(patch: string): string {
  const out: string[] = [];
  let line = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      line = Number(hunk[1]);
      out.push(raw);
    } else if (raw.startsWith("-")) {
      out.push(`     ${raw}`);
    } else if (!raw.startsWith("\\")) {
      out.push(`${String(line).padStart(4)} ${raw}`);
      line++;
    }
  }
  return out.join("\n");
}

interface PrDiff {
  text: string;
  files: { path: string; patch: string }[];
}

function loadDiff(repo: string, pr: number, commit: string): PrDiff | null {
  const cache = `data/${repo.replace("/", "__")}/eval-diff-${pr}.json`;
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"));
  let diff: PrDiff | null = null;
  try {
    const base = JSON.parse(gh(`repos/${repo}/pulls/${pr}`)).base.sha as string;
    const files = (JSON.parse(gh(`repos/${repo}/compare/${base}...${commit}`)).files as
      { filename: string; patch?: string; status: string }[])
      .filter((f) => f.patch && f.status !== "removed" && !IGNORED_FILES.test(f.filename))
      .map((f) => ({ path: f.filename, patch: f.patch! }));
    const text = files.map((f) => `<file path="${f.path}">\n${annotatePatch(f.patch)}\n</file>`).join("\n");
    if (text && text.length <= MAX_DIFF_CHARS) diff = { text, files };
  } catch {
    // commit removed by a force-push, or PR not accessible
  }
  fs.writeFileSync(cache, JSON.stringify(diff));
  return diff;
}

// ── Repo context (variant C) ─────────────────────────────────────────────────

async function repoContext(index: CodeIndex, diff: PrDiff) {
  const blocks = diff.files.flatMap((f) =>
    addedBlocks(f.patch)
      .flatMap((b) => chunkCode(b.text).map((c) => c.content))
      .filter((text) => text.split("\n").filter((l) => l.trim()).length >= 3)
      .map((text) => ({ file: f, text, changed: changedOldRanges(f.patch) }))
  );
  const vectors = blocks.length ? await embedMany(blocks.map((b) => `${b.file.path}\n${b.text}`)) : [];

  const best = new Map<string, { path: string; startLine: number; endLine: number; symbol: string | null; content: string; similarity: number }>();
  blocks.forEach((b, i) => {
    for (const { chunk, similarity } of nearest(index, vectors[i], 3)) {
      if (similarity < MIN_SIMILARITY) continue;
      const overlapsChange = chunk.path === b.file.path &&
        b.changed.some(([from, to]) => chunk.startLine <= to && chunk.endLine >= from);
      if (overlapsChange) continue;
      const key = `${chunk.path}:${chunk.startLine}`;
      if (!best.has(key) || best.get(key)!.similarity < similarity) best.set(key, { ...chunk, similarity });
    }
  });
  const existing = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, MAX_EXISTING);
  const existingText = existing
    .map((c) => `<code path="${c.path}" lines="${c.startLine}-${c.endLine}"${c.symbol ? ` symbol="${c.symbol}"` : ""}>\n${c.content}\n</code>`)
    .join("\n");
  return { catalog: helperCatalog(index, diff.files.map((f) => f.path)), existing: existingText };
}

// ── Review (same prompt for all three variants; only the context sections change) ──

const ReviewSchema = z.object({
  findings: z.array(z.object({ path: z.string(), line: z.number().int(), body: z.string() })),
});

const REVIEW_PROMPT = `You are a Principal Software Engineer auditing this pull request as an extremely strict Tech Lead.

Your mission is NOT to find basic syntax errors (linters do that). Find hidden structural flaws, redundancy, violations of the team's rules and conventions, and code that will not scale or will be hard to maintain.

Input (any section may be empty):
- <team_guidelines>: the files where the team documents its rules (AGENTS.md, CLAUDE.md…).
- <learned_rules>: rules learned from the team's past code reviews.
- <helper_catalog>: signatures of functions in the shared modules of the packages this PR touches, with file and line. If new code reimplements one of them, even under another name, report it and name the helper.
- <existing_code>: code that already exists in the repo and looks like the new code. If the new code duplicates or contradicts it, report it citing the file and line; if it only looks similar, say nothing.
- <diff>: the changed files. Lines on the new side are numbered on the left.

Output:
- Every finding is tied to a file path and a line number that appears numbered in the diff.
- Report every real problem you find; one finding per problem. No formatting or style nits.
- Be direct: explain the impact and the fix. Write in English.`;

interface Context {
  rules: string;
  catalog: string;
  existing: string;
}

async function review(label: string, docsText: string, ctx: Context, diff: string) {
  const { findings } = await ask(
    label,
    REVIEW_PROMPT,
    `<team_guidelines>\n${docsText}\n</team_guidelines>\n\n<learned_rules>\n${ctx.rules}\n</learned_rules>\n\n` +
      `<helper_catalog>\n${ctx.catalog}\n</helper_catalog>\n\n<existing_code>\n${ctx.existing}\n</existing_code>\n\n` +
      `<diff>\n${diff}\n</diff>`,
    ReviewSchema,
  );
  return findings;
}

// ── Judge ────────────────────────────────────────────────────────────────────

const JudgeSchema = z.object({
  matches: z.array(z.object({ human_id: z.string(), finding_ids: z.array(z.string()) })),
});

const JUDGE_PROMPT = `You compare automated code review findings with the comments human reviewers left on the same pull request.

For each human comment (h1, h2…), list the ids of the findings (f1, f2…) that raise the same concern: acting on the finding would address what the human asked for. Being in the same file is not enough, and a vague or generic finding does not match a specific request. Be strict. Return an empty list for a human comment that no finding covers.`;

type Finding = { path: string; line: number; body: string };

async function judge(human: ReviewComment[], findings: Finding[]): Promise<boolean[]> {
  if (findings.length === 0) return human.map(() => false);
  const { matches } = await ask(
    "judge",
    JUDGE_PROMPT,
    `<human_comments>\n${human.map((c, i) => `<comment id="h${i + 1}" path="${c.path}">\n${c.body.slice(0, 1200)}\n</comment>`).join("\n")}\n</human_comments>\n\n` +
      `<findings>\n${findings.map((f, i) => `<finding id="f${i + 1}" path="${f.path}" line="${f.line}">\n${f.body.slice(0, 1200)}\n</finding>`).join("\n")}\n</findings>`,
    JudgeSchema,
  );
  const byHuman = new Map(matches.map((m) => [m.human_id, m.finding_ids.length > 0]));
  return human.map((_, i) => byHuman.get(`h${i + 1}`) ?? false);
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

const VARIANTS = ["A", "B", "C"] as const;
type Variant = (typeof VARIANTS)[number];

async function main() {
  const repo = process.argv[2];
  if (!repo?.includes("/")) throw new Error("Usage: npx tsx eval.ts <owner/repo> [--prs 15] [--pages 20] [--fresh-rules]");
  const testSize = arg("prs", 15);
  const out = `evals/${repo.split("/")[1]}`;

  const human = fetchComments(repo, arg("pages", 20)).filter(isUseful);
  const docs = fetchInstructionFiles(repo);
  const docsText = docs.map((d) => `<file path="${d.path}">\n${d.content.slice(0, MAX_DOC_CHARS)}\n</file>`).join("\n\n");

  // PRs with human review; the most recent ones with a usable diff are the test set
  const byPr = new Map<number, ReviewComment[]>();
  for (const c of human) byPr.set(prNumber(c), [...(byPr.get(prNumber(c)) ?? []), c]);
  const prs = [...byPr]
    .map(([pr, cs]) => ({ pr, comments: cs.sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
    .filter((p) => p.comments.length >= MIN_HUMAN_COMMENTS)
    .sort((a, b) => b.comments[0].created_at.localeCompare(a.comments[0].created_at));
  const test: { pr: number; comments: ReviewComment[]; diff: PrDiff }[] = [];
  for (const p of prs) {
    if (test.length >= testSize) break;
    const commit = p.comments[0].original_commit_id;
    const diff = commit ? loadDiff(repo, p.pr, commit) : null;
    if (diff) test.push({ ...p, diff });
  }
  const cutoff = test.map((t) => t.comments[0].created_at).sort()[0];
  const testPrs = new Set(test.map((t) => t.pr));
  const train = human.filter((c) => c.created_at < cutoff && !testPrs.has(prNumber(c)));
  console.log(
    `${repo}: training ${train.length} comments (before ${cutoff.slice(0, 10)}) · ` +
      `test ${test.length} PRs, ${test.reduce((n, t) => n + t.comments.length, 0)} comments · model ${MODEL}`,
  );

  // Rules learned from the past (reused across runs so B stays comparable)
  const previous = fs.existsSync(`${out}.json`) ? JSON.parse(fs.readFileSync(`${out}.json`, "utf8")) : null;
  const rules: { title: string; rule: string; why: string }[] =
    previous?.rules && !process.argv.includes("--fresh-rules") ? previous.rules : (await mineRules(repo, train, docs)).rules;
  const rulesText = rules.map((r) => `## ${r.title}\n${r.rule}\nWhy: ${r.why}`).join("\n\n");
  console.log(`${rules.length} learned rules${previous?.rules ? " (reused)" : ""}`);

  // Code index as it was at the cutoff date: without the fixes that came later
  const snapshot = commitAt(repo, cutoff);
  const index = await buildIndex(repo, snapshot);

  const results = [];
  const covered: Record<Variant, number> = { A: 0, B: 0, C: 0 };
  const findingCount: Record<Variant, number> = { A: 0, B: 0, C: 0 };
  for (const t of test) {
    const context = await repoContext(index, t.diff);
    const contexts: Record<Variant, Context> = {
      A: { rules: "", catalog: "", existing: "" },
      B: { rules: rulesText, catalog: "", existing: "" },
      C: { rules: rulesText, ...context },
    };
    const row: Record<string, unknown> = { pr: t.pr, human: t.comments.map((c) => ({ path: c.path, body: c.body, url: c.html_url })) };
    const line: string[] = [];
    for (const v of VARIANTS) {
      const findings = await review(`${v} #${t.pr}`, docsText, contexts[v], t.diff.text);
      const hits = await judge(t.comments, findings);
      covered[v] += hits.filter(Boolean).length;
      findingCount[v] += findings.length;
      row[v] = { findings, hits };
      line.push(`${v} ${hits.filter(Boolean).length}`);
    }
    console.log(`#${t.pr}: human ${t.comments.length} · ${line.join(" · ")}`);
    results.push(row);
  }

  const total = test.reduce((n, t) => n + t.comments.length, 0);
  const summary = {
    repo, model: MODEL, cutoff, snapshot, trainComments: train.length, rulesLearned: rules.length,
    testPrs: test.length, humanComments: total,
    variants: Object.fromEntries(VARIANTS.map((v) => [v, { covered: covered[v], recall: covered[v] / total, findings: findingCount[v] }])),
    costUsd: usage.usd,
  };
  fs.mkdirSync("evals", { recursive: true });
  fs.writeFileSync(`${out}.json`, JSON.stringify({ summary, rules, results }, null, 2));

  const pct = (x: number) => `${Math.round(x * 100)} %`;
  console.log(`\nHuman comments anticipated (of ${total}):`);
  for (const v of VARIANTS) {
    console.log(`  ${v}: ${covered[v]} (${pct(covered[v] / total)}) with ${findingCount[v]} findings`);
  }
  console.log(`Claude cost ≈ $${usage.usd.toFixed(2)} → ${out}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
