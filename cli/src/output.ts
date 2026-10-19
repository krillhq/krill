// Files the CLI writes: .krill/rules.md (the rules, editable), .krill/report.md (the evidence)
// and, on sync, the rules block inside AGENTS.md, CLAUDE.md… of the local checkout.
import fs from "node:fs";
import path from "node:path";
import type { MiningResult } from "../../supabase/functions/_shared/mining-core.ts";
import { RULES_PATH, severityLine } from "../../supabase/functions/_shared/rules-format.ts";
import { AGENT_FILES, buildBlock, DEFAULT_AGENT_FILE, upsertBlock } from "../../supabase/functions/_shared/agent-block.ts";

export const REPORT_PATH = ".krill/report.md";

const COVERAGE = { missing: "❌ Missing", partial: "⚠️ Partial", documented: "✅ Documented" };

const title = (repo: string) => `# Team rules · ${repo}`;

export function renderRules(repo: string, result: MiningResult): string {
  const intro =
    "Rules this repo's reviewers ask for again and again, discovered by Krill from its review history.\nReview them: edit, delete what doesn't apply and add what's missing. The evidence for each one is in `.krill/report.md`.";
  const sections = result.rules.map(
    (r) => `## ${r.title}\n\n${r.rule}\n\n${severityLine(r.blocking)}\n\nWhy: ${r.why}`,
  );
  return `${title(repo)}\n\n${intro}\n\n${sections.join("\n\n")}\n`;
}

export function renderReport(repo: string, result: MiningResult): string {
  const stats = `${result.humanComments} human review comments analyzed · existing docs: ${result.guidelineFiles.join(", ") || "none"}`;
  const rules = result.rules.map((r, i) => {
    const where = r.documentedIn ? ` (\`${r.documentedIn}\`)` : "";
    const quotes = r.evidence.map((e) => `- [PR #${e.pr} · @${e.reviewer}](${e.url}): "${e.quote}"`).join("\n");
    return `## ${i + 1}. ${r.blocking ? "⛔ " : ""}${r.title}

${r.rule}

${COVERAGE[r.coverage]}${where} · ${r.coverageNote}
_${r.evidence.length} comments_

${quotes}`;
  });
  return `${title(repo)}\n\n${stats}\n\n${rules.join("\n\n")}\n`;
}

export function writeFile(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return relPath;
}

// Updates the block in the agent files that already exist; if there are none, creates AGENTS.md
export function syncAgentFiles(dir: string, rulesMarkdown: string): string[] {
  const block = buildBlock(rulesMarkdown);
  const existing = AGENT_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length === 0) return [writeFile(dir, DEFAULT_AGENT_FILE, `${block}\n`)];
  return existing.map((f) => writeFile(dir, f, upsertBlock(fs.readFileSync(path.join(dir, f), "utf8"), block)));
}

export { RULES_PATH };
