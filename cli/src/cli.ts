// krill-rules: discovers a repo's unwritten rules from its code review history
// and writes them to .krill/rules.md (and, with --sync, into AGENTS.md / CLAUDE.md…).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Ask, isUseful, mineComments, type MiningResult } from "../../supabase/functions/_shared/mining-core.ts";
import { currentRepo, fetchGuidelines, fetchReviewComments } from "./github.ts";
import { createAsk, DEFAULT_MODELS, findClaude, type ProviderName } from "./providers.ts";
import * as ui from "./ui.ts";
import { c } from "./ui.ts";
import { renderReport, renderRules, REPORT_PATH, RULES_PATH, syncAgentFiles, writeFile } from "./output.ts";

const HELP = `krill-rules — discover the unwritten rules your code reviewers keep asking for.

Usage:
  krill-rules [owner/repo] [options]   discover the rules
  krill-rules sync [--dir <path>]      copy .krill/rules.md into the AI agent files (no model needed)

Reads the repo's pull request review comments with the GitHub CLI (gh), finds the rules
reviewers ask for again and again, checks which ones are already documented, and writes:
  .krill/rules.md    the rules, ready to edit
  .krill/report.md   the evidence: review comments behind each rule

Options:
  --provider <name>  anthropic | claude-code | ollama
                     (default: anthropic if ANTHROPIC_API_KEY is set, otherwise claude-code)
  --model <id>       model for the provider (defaults: ${Object.entries(DEFAULT_MODELS).map(([p, m]) => `${p}=${m}`).join(", ")})
  --max-comments <n> most recent review comments to read (default 1000; 200 with ollama)
  --dir <path>       where to write the files (default: current directory)
  --sync             also copy the rules into the AI agent files right away (see below)
  --dry-run          fetch the comments and stop before calling any model
  -h, --help         show this help

Without owner/repo, uses the GitHub repo of the current directory.

AI agent files: the rules go into a delimited block in AGENTS.md, CLAUDE.md, .cursorrules and
.github/copilot-instructions.md, whichever exist in --dir (AGENTS.md is created if none do).
The rest of each file is left untouched; running sync again replaces only the block.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "max-comments": { type: "string" },
      dir: { type: "string", default: "." },
      sync: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);
  if (positionals[0] === "sync") return sync(values.dir);

  if (values.provider && !(values.provider in DEFAULT_MODELS)) {
    throw new Error(`Unknown provider "${values.provider}". Use anthropic, claude-code or ollama.`);
  }
  const repo = positionals[0] ?? (await currentRepo());
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Expected owner/repo, got "${repo}"`);
  const maxComments = Number(values["max-comments"] ?? (values.provider === "ollama" ? 200 : 1000));

  ui.line(`${c.bold("🦐 krill-rules")} ${c.dim("·")} ${c.cyan(repo)}
`);

  ui.startSpinner("Reading review comments…");
  const [comments, docs] = await Promise.all([
    fetchReviewComments(repo, maxComments, (n) => ui.updateSpinner(`Reading review comments… ${n}`)),
    fetchGuidelines(repo),
  ]);
  ui.stopSpinner();
  const human = comments.filter(isUseful).length;
  ui.done(`Read ${comments.length} review comments ${c.dim(`(${human} written by people)`)}`);
  if (docs.length) ui.done(`Found existing docs: ${docs.map((d) => d.path).join(", ")}`);
  else ui.warn("No AGENTS.md, CLAUDE.md or CONTRIBUTING.md yet");
  if (values["dry-run"]) {
    ui.line(`
${c.dim("Dry run: stopping before the model.")} ${human < 20 ? c.yellow("That's little review history; expect few rules.") : ""}`);
    return;
  }

  // The model is picked after reading GitHub: --dry-run doesn't need one
  const provider = (values.provider ?? defaultProvider()) as ProviderName;
  const model = values.model ?? DEFAULT_MODELS[provider];
  ui.done(`Using ${PROVIDER_LABELS[provider]} ${c.dim(`(${model})`)}`);

  const result = await mineComments(repo, comments, docs, withProgress(createAsk(provider, model), human));
  ui.stopSpinner();
  if (result.rules.length === 0) {
    ui.warn(`No rules found in ${result.humanComments} human review comments. Krill learns from review history, so it needs repos with reviewed PRs.`);
    return;
  }

  const rules = renderRules(repo, result);
  const written = [writeFile(values.dir, RULES_PATH, rules), writeFile(values.dir, REPORT_PATH, renderReport(repo, result))];
  const synced = values.sync ? syncAgentFiles(values.dir, rules) : [];
  printSummary(result);

  ui.line(`${c.green("✔")} Wrote ${written.join(" and ")}${synced.length ? ` and updated ${synced.join(", ")}` : ""}`);
  ui.line(`
${c.bold("Next:")}`);
  if (synced.length) {
    ui.line(`  Review the changes and commit them: ${c.cyan(`git add .krill ${synced.join(" ")}`)}`);
  } else {
    ui.line(`  1. Review the rules (edit, delete, add):  ${c.cyan(`code ${RULES_PATH}`)}`);
    ui.line(`  2. Copy them into your AI agent files:   ${c.cyan("npx krill-rules sync")}`);
  }
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "the Anthropic API",
  "claude-code": "Claude Code",
  ollama: "Ollama",
};

const STEP_LABELS: Record<string, (human: number) => string> = {
  mine: (human) => `Finding repeated rules in ${human} review comments…`,
  audit: () => "Checking every quote and comparing with your docs…",
};

// Shows a spinner while the model works, and a ✔ with the result of each step
function withProgress(ask: Ask, human: number): Ask {
  return async (step, system, content, schema) => {
    const started = Date.now();
    ui.startSpinner(STEP_LABELS[step]?.(human) ?? `${step}…`);
    try {
      const out = await ask(step, system, content, schema);
      const found = (out as { rules?: unknown[]; audits?: unknown[] }).rules?.length ?? (out as { audits?: unknown[] }).audits?.length;
      const what = step === "mine" ? `Found ${found} candidate rules` : `Checked ${found} rules against their quotes and your docs`;
      ui.stopSpinner();
      ui.done(`${what} ${c.dim(ui.elapsedSince(started))}`);
      return out;
    } catch (err) {
      ui.stopSpinner();
      throw err;
    }
  };
}

function printSummary(result: MiningResult) {
  const missing = result.rules.filter((r) => r.coverage === "missing").length;
  const partial = result.rules.filter((r) => r.coverage === "partial").length;
  const blocking = result.rules.filter((r) => r.blocking).length;
  const parts = [c.red(`${missing} missing from your docs`), c.yellow(`${partial} partial`)];
  if (blocking) parts.push(`${blocking} blocking`);
  ui.line(`
${c.bold(`${result.rules.length} rules`)} ${c.dim("·")} ${parts.join(c.dim(" · "))}
`);

  const width = (process.stderr.columns || 100) - 24;
  const label = { missing: c.red("missing   "), partial: c.yellow("partial   "), documented: c.green("documented") };
  for (const r of result.rules) {
    const title = r.title.length > width ? `${r.title.slice(0, width - 1)}…` : r.title;
    ui.line(`  ${label[r.coverage]}  ${r.blocking ? c.red("⛔ ") : ""}${title} ${c.dim(`(${r.evidence.length})`)}`);
  }
  ui.line();
}

// Copies the reviewed rules into the agent files, without calling the model again
function sync(dir: string) {
  const file = path.join(dir, RULES_PATH);
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run krill-rules first to discover the rules.`);
  const rules = fs.readFileSync(file, "utf8");
  const written = syncAgentFiles(dir, rules);
  ui.done(`Copied ${RULES_PATH} into ${written.join(", ")}`);
  ui.line(`
${c.bold("Next:")} commit them so your AI agents pick them up: ${c.cyan(`git add .krill ${written.join(" ")}`)}`);
}

function defaultProvider(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (findClaude()) return "claude-code";
  throw new Error(`no AI model found. Pick one:

  • Claude Code (uses your Claude subscription): install it from https://claude.com/claude-code
    and log in once by running \`claude\`. If it's installed somewhere unusual, set KRILL_CLAUDE_BIN.
  • Anthropic API key: set ANTHROPIC_API_KEY (a run costs a few cents with Haiku).
  • Ollama (free, local): install https://ollama.com, run \`ollama pull ${DEFAULT_MODELS.ollama}\`,
    then add --provider ollama.`);
}

main().catch((err) => {
  ui.fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
