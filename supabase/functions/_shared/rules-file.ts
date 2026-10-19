// Text of the .krill/rules.md file and of the "Your team's rules" pull request description.
import type { MinedRule, MiningResult } from "./mining-core.ts";
import { RULES_PATH, severityLine } from "./rules-format.ts";

const MAX_EVIDENCE_LINKS = 3;

const title = (repo: string) => `# Team rules · ${repo}`;

const INTRO =
  "Krill Lab checks every pull request against these rules and copies them into the files AI agents read (AGENTS.md, CLAUDE.md…).\nThis file is the source of truth: edit it, delete what doesn't apply and add what's missing.\nEach rule has a severity: “blocking” fails the check and blocks the merge; “warning” only comments.";

const TEMPLATE = `<!-- Write your team's architecture rules here. One "##" section per rule, in the imperative, with its reason. -->

## Example: reuse existing helpers

Before writing new logic, check whether it already exists in \`src/utils/\`; if it repeats, extract it into a shared helper.

Severity: warning

Why: duplicated logic drifts over time and a fix reaches one copy but not the other.`;

const COVERAGE = { missing: "❌ Missing", partial: "⚠️ Partial", documented: "✅ Documented" };

function files(r: MiningResult, none: string): string {
  return r.guidelineFiles.length ? r.guidelineFiles.map((f) => `\`${f}\``).join(", ") : none;
}

function agentFiles(r: MiningResult): string {
  const agents = r.guidelineFiles.filter((f) => !/CONTRIBUTING/i.test(f));
  return agents.length ? agents.map((f) => `\`${f}\``).join(", ") : "`AGENTS.md`";
}

export function renderRulesFile(repo: string, rules: MinedRule[]): string {
  const sections = rules.map((r) => `## ${r.title}\n\n${r.rule}\n\n${severityLine(r.blocking)}\n\nWhy: ${r.why}`);
  return `${title(repo)}\n\n${INTRO}\n\n${sections.join("\n\n")}\n`;
}

export function renderTemplateFile(repo: string): string {
  return `${title(repo)}\n\n${INTRO}\n\n${TEMPLATE}\n`;
}

export function renderPullRequest(r: MiningResult): { title: string; body: string } {
  if (r.rules.length === 0) {
    return {
      title: "🦐 Start writing your team's rules",
      body: `## 🦐 Start writing your team's rules

I analyzed this repository's review history but found **${r.humanComments} human review comments**, which is not enough to infer rules with confidence.

This PR adds \`${RULES_PATH}\` with an example. Write your team's architecture rules there and merge: Krill Lab will check every pull request against them and copy them into the files AI agents read. As your team reviews PRs, I'll propose new rules.`,
    };
  }

  const gap = r.rules.filter((rule) => rule.coverage !== "documented").length;
  const cell = (text: string) => text.replace(/\|/g, "\|").replace(/\n/g, " ");
  const rows = r.rules.map((rule) => {
    const status = `${COVERAGE[rule.coverage]}${rule.documentedIn ? ` (\`${rule.documentedIn}\`)` : ""}<br><sub>${cell(rule.coverageNote)}</sub>`;
    const links = rule.evidence
      .slice(0, MAX_EVIDENCE_LINKS)
      .map((e) => `[#${e.pr}](${e.url}) @${e.reviewer}`)
      .join("<br>");
    const more = rule.evidence.length > MAX_EVIDENCE_LINKS ? `<br>+${rule.evidence.length - MAX_EVIDENCE_LINKS}` : "";
    return `| ${rule.blocking ? "⛔ " : ""}**${cell(rule.title)}** | ${status} | ${links}${more} |`;
  });
  const body = `## 🦐 Your team's rules

I analyzed **${r.humanComments} human review comments** in this repository and found **${r.rules.length} ${r.rules.length === 1 ? "rule" : "rules"}** your team asks for again and again. **${gap}** are missing or only partly written down in ${files(r, "any guideline file")}.

When you merge this PR:
- Krill Lab will check every pull request against these rules and fail the check when one is broken critically.
- AI agents will read them from ${agentFiles(r)} while writing code.

**Review each rule before merging.** Edit \`${RULES_PATH}\` in this PR to fix, delete or add rules, and to choose which ones are blocking (⛔).

| Rule | In your docs | Asked for by |
|---|---|---|
${rows.join("\n")}`;
  return { title: "🦐 Your team's rules", body };
}
